#!/usr/bin/env python3
"""Statikus aloldalak generátora (csak standard könyvtár).

Az index.html a SABLON: ebből készül minden aloldal (head, h1 és bevezető,
boot-szkript cseréjével), a főoldal pedig maga az index.html, benne a
generált "Települések" listával. Kimenet: eso/<slug>/index.html, sitemap.xml,
és (a --fetch-climate kapcsolóval) a climate-hu.json hiányzó bejegyzései.

Használat (a repó gyökeréből):
  python3 tools/build_pages.py                        # hálózat nélkül
  python3 tools/build_pages.py --fetch-climate        # hiányzó klíma lekérése (Action)
  python3 tools/build_pages.py --fetch-climate --climate-limit 3   # helyi teszt
  python3 tools/build_pages.py --fetch-water          # vízállás-oldalak (worker pillanatképei)
  python3 tools/build_pages.py --fetch-history        # folyó év vízállás-táblái -> water-history.json
  python3 tools/build_pages.py --water-dir DIR        # teszt: DIR/rivers.json + lakes.json
  python3 tools/build_pages.py --fetch-recent         # friss csapadék a településekhez (Action)
  python3 tools/build_pages.py --fetch-recent --recent-limit 3     # helyi teszt (legfeljebb 3 hely)

Új oldaltípus (víz, /cigand/, /ho/, /widget/): írj egy builder függvényt, ami
`Ctx`-ből `Page` listát ad, és vedd fel a PAGE_BUILDERS listába. A közös
render_page() rakja össze az oldalt a sablonból.
"""

import argparse
import datetime
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = "https://holazeso.hu"
SITE_NAME = "hol az eső?"

CLIMATE_YEARS = (2013, 2024)
CLIMATE_PERIOD = f"{CLIMATE_YEARS[0]}-{CLIMATE_YEARS[1]}"
CLIMATE_API = "https://archive-api.open-meteo.com/v1/archive"
CLIMATE_BATCH = 4          # hely / kérés
CLIMATE_SLEEP = 15         # másodperc két kérés között
RAIN_DAY_MM = 1.0          # ennyitől számít "esős napnak"

MONTHS = ["január", "február", "március", "április", "május", "június",
          "július", "augusztus", "szeptember", "október", "november", "december"]

TEMPLATE_MARKERS = {
    "content": ("<!--GEN:content-->", "<!--/GEN:content-->"),
    "places": ("<!--GEN:places-->", "<!--/GEN:places-->"),
}


# ---------------------------------------------------------------------------
# Közös típusok

@dataclass
class Page:
    path: str            # URL-útvonal, pl. "/" vagy "/eso/kecskemet/"
    html: str
    indexable: bool = True


@dataclass
class Ctx:
    template: str
    places: list
    climate: dict
    today: str
    water: object = None   # (rivers, lakes) pillanatkép vagy None
    recent: dict = field(default_factory=dict)   # town-recent.json tartalma
    extra: dict = field(default_factory=dict)
    files: dict = field(default_factory=dict)   # repó-relatív útvonal -> szöveg (pl. data/vizallas/*.json)


def page_file(path):
    """URL-útvonalból fájl a repóban."""
    if path == "/":
        return ROOT / "index.html"
    if path.endswith(".html"):
        return ROOT / path.strip("/")
    return ROOT / path.strip("/") / "index.html"


# ---------------------------------------------------------------------------
# Sablon-render

def esc(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def replace_between(html, marker, inner):
    start, end = TEMPLATE_MARKERS[marker]
    i, j = html.index(start), html.index(end)
    return html[:i + len(start)] + "\n" + inner + "\n    " + html[j:]


_REL_ATTR = re.compile(r'(\s(?:href|src))="(?!https?:|//|/|#|data:|mailto:)([^"]+)"')


def absolutize(html):
    """A sablon relatív asset-hivatkozásai gyökér-abszolútak lesznek."""
    return _REL_ATTR.sub(lambda m: f'{m.group(1)}="/{m.group(2)}"', html)


def set_head(html, title, description, canonical, jsonld):
    def sub(pattern, repl):
        nonlocal html
        html, n = re.subn(pattern, lambda _m: repl, html, count=1, flags=re.S)
        assert n == 1, pattern

    t, d = esc(title), esc(description)
    sub(r"<title>.*?</title>", f"<title>{t}</title>")
    sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{d}">')
    sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{canonical}">')
    sub(r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{t}">')
    sub(r'<meta property="og:description" content="[^"]*">', f'<meta property="og:description" content="{d}">')
    sub(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{canonical}">')
    sub(r'<meta name="twitter:title" content="[^"]*">', f'<meta name="twitter:title" content="{t}">')
    sub(r'<meta name="twitter:description" content="[^"]*">', f'<meta name="twitter:description" content="{d}">')
    sub(r'<script type="application/ld\+json">.*?</script>',
        '<script type="application/ld+json">\n'
        + json.dumps(jsonld, ensure_ascii=False, indent=2) + "\n</script>")
    return html


WATER_PANEL_RE = re.compile(
    r'(<section id="water-panel" class="water-details")( hidden>)\n(.*?)\n    </section>\n\n  </main>', re.S)


def water_panel_fragment(template):
    """A sablon #water-panel szekciójának belseje: ez a /water-panel.html."""
    m = WATER_PANEL_RE.search(template)
    assert m, "water-panel"
    return m.group(3) + "\n"


def slim_water_panel(html):
    """Generált oldalakon üres a panel (data-fragment): a markupot a script.js tölti a /water-panel.html-ből."""
    html, n = WATER_PANEL_RE.subn(
        lambda m: m.group(1) + ' data-fragment hidden></section>\n\n  </main>', html, count=1)
    assert n == 1, "water-panel"
    return html


def render_page(ctx, *, path, title, description, h1, content_html,
                boot_script="", indexable=True, q1=None, slim_water=False):
    """Egy aloldal a sablonból. A lap egyetlen h1-e a #q1-question (az app
    tetején): q1 a statikus szövege (a script.js később átírja); a content_html
    SEO-szakaszának címe h2."""
    canonical = BASE_URL + path
    html = set_head(ctx.template, title, description, canonical, {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": h1,
        "url": canonical,
        "description": description,
        "inLanguage": "hu",
        "isPartOf": {"@type": "WebSite", "name": "holazeso.hu", "url": BASE_URL + "/"},
    })
    if not indexable:
        html = html.replace("<title>", '<meta name="robots" content="noindex">\n<title>', 1)
    html = replace_between(html, "content", content_html)
    if slim_water:
        html = slim_water_panel(html)
    if q1:
        html, n = re.subn(r'(<h1 class="question" id="q1-question">)[^<]*(</h1>)',
                          lambda m: m.group(1) + esc(q1) + m.group(2), html, count=1)
        assert n == 1, "q1-question"
    html = absolutize(html)
    if boot_script:
        marker = '<script src="/script.js'
        assert marker in html
        html = html.replace(marker, f"<script>{boot_script}</script>\n  {marker}", 1)
    return Page(path, html, indexable)


# ---------------------------------------------------------------------------
# Adatok

def load_places():
    places = json.loads((ROOT / "places-hu.json").read_text(encoding="utf-8"))
    for p in places:
        assert p.get("slug") and p.get("loc"), p
    assert len({p["slug"] for p in places}) == len(places), "ismétlődő slug"
    return places


def load_climate():
    f = ROOT / "climate-hu.json"
    if f.exists():
        data = json.loads(f.read_text(encoding="utf-8"))
        if data.get("period") == CLIMATE_PERIOD:
            return data
    return {"period": CLIMATE_PERIOD, "places": {}}


def save_climate(climate):
    f = ROOT / "climate-hu.json"
    text = json.dumps(climate, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    if not f.exists() or f.read_text(encoding="utf-8") != text:
        f.write_text(text, encoding="utf-8")


def summarize_daily(times, precip):
    """Napi csapadékból: éves átlag (mm), legcsapadékosabb hónap, esős napok/év."""
    years = CLIMATE_YEARS[1] - CLIMATE_YEARS[0] + 1
    month_sum = [0.0] * 12
    total = 0.0
    wet_days = 0
    for t, v in zip(times, precip):
        if v is None:
            continue
        total += v
        month_sum[int(t[5:7]) - 1] += v
        if v >= RAIN_DAY_MM:
            wet_days += 1
    month_avg = [m / years for m in month_sum]
    best = max(range(12), key=lambda i: month_avg[i])
    return {
        "annual_mm": int(round(total / years)),
        "wet_month": best + 1,
        "wet_month_mm": int(round(month_avg[best])),
        "rain_days": int(round(wet_days / years)),
    }


def fetch_climate_batch(batch):
    q = urllib.parse.urlencode({
        "latitude": ",".join(str(p["lat"]) for p in batch),
        "longitude": ",".join(str(p["lon"]) for p in batch),
        "start_date": f"{CLIMATE_YEARS[0]}-01-01",
        "end_date": f"{CLIMATE_YEARS[1]}-12-31",
        "daily": "precipitation_sum",
        "timezone": "Europe/Budapest",
    })
    req = urllib.request.Request(f"{CLIMATE_API}?{q}", headers={"User-Agent": "holazeso-build-pages"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    if isinstance(data, dict):
        data = [data]
    out = {}
    for p, d in zip(batch, data):
        daily = d["daily"]
        out[p["slug"]] = summarize_daily(daily["time"], daily["precipitation_sum"])
    return out


def fetch_missing_climate(places, climate, limit=None):
    """Csak a hiányzó helyekre kér, kis csomagokban, várakozással. Hibánál
    (pl. 429) abbahagyja: a hiányzók egyszerűen kimaradnak az oldalakról."""
    missing = [p for p in places if p["slug"] not in climate["places"]]
    if limit is not None:
        missing = missing[:limit]
    print(f"klíma: {len(missing)} hiányzó hely lekérése", file=sys.stderr)
    for i in range(0, len(missing), CLIMATE_BATCH):
        batch = missing[i:i + CLIMATE_BATCH]
        try:
            climate["places"].update(fetch_climate_batch(batch))
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            print(f"klíma: hiba ({err}), a lekérés leáll", file=sys.stderr)
            break
        save_climate(climate)
        if i + CLIMATE_BATCH < len(missing):
            time.sleep(CLIMATE_SLEEP)


# ---------------------------------------------------------------------------
# Friss, napi adat a településoldalakhoz (town-recent.json): elmúlt napok
# csapadéka, holnapi előrejelzés (--fetch-recent), legközelebbi vízmérce
# (a vízállás-pillanatképből, ha az elérhető). Alapfutás: a tárolt fájlt használja.

RECENT_FILE = ROOT / "town-recent.json"
FORECAST_API = "https://api.open-meteo.com/v1/forecast"
RECENT_PAST_DAYS = 30      # ennyi napban keressük az utolsó >= 1 mm-es napot
RECENT_WEEK = 7
RECENT_BATCH = 50          # hely / kérés
RECENT_SLEEP = 5           # másodperc két kérés között
WATER_MAX_KM = 60


def load_recent():
    if RECENT_FILE.exists():
        try:
            data = json.loads(RECENT_FILE.read_text(encoding="utf-8"))
            if isinstance(data.get("places"), dict):
                return data
        except ValueError:
            pass
    return {"date": None, "places": {}}


def save_recent(recent):
    text = json.dumps(recent, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    if not RECENT_FILE.exists() or RECENT_FILE.read_text(encoding="utf-8") != text:
        RECENT_FILE.write_text(text, encoding="utf-8")


def summarize_recent(times, precip, prob):
    """A napi sorokból (a past_days napot a mai nap és a holnap követi) egy hely
    összegzése. A "mai" nap indexe a times-ban RECENT_PAST_DAYS. A mai (még
    nem lezárt) nap nem számít bele az elmúlt napokba."""
    t0 = RECENT_PAST_DAYS
    past = precip[t0 - RECENT_WEEK:t0]
    if any(v is None for v in past):
        past = [v or 0 for v in past]
    week = sum(past)
    out = {"week_mm": round(week, 1)}
    last = None
    window = range(t0 - 1, t0 - 1 - (RECENT_WEEK if week >= RAIN_DAY_MM else RECENT_PAST_DAYS), -1)
    for i in window:                      # az utolsó legalább 1 mm-es nap
        if (precip[i] or 0) >= RAIN_DAY_MM:
            last = times[i]
            break
    if last is None and week >= RAIN_DAY_MM:   # csupa apró csepp: az utolsó nedves nap
        for i in range(t0 - 1, t0 - 1 - RECENT_WEEK, -1):
            if (precip[i] or 0) > 0:
                last = times[i]
                break
    out["last"] = last
    out["tomorrow"] = times[t0 + 1]
    out["tomorrow_mm"] = round(precip[t0 + 1] or 0, 1) if precip[t0 + 1] is not None else None
    out["tomorrow_prob"] = prob[t0 + 1] if prob[t0 + 1] is not None else None
    return out


def fetch_recent_batch(batch):
    q = urllib.parse.urlencode({
        "latitude": ",".join(str(p["lat"]) for p in batch),
        "longitude": ",".join(str(p["lon"]) for p in batch),
        "daily": "precipitation_sum,precipitation_probability_max",
        "past_days": RECENT_PAST_DAYS, "forecast_days": 2,
        "timezone": "Europe/Budapest",
    }, safe=",")
    req = urllib.request.Request(f"{FORECAST_API}?{q}", headers={"User-Agent": "holazeso-build-pages"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    if isinstance(data, dict):
        data = [data]
    assert len(data) == len(batch), "hibás válaszhossz"
    out, date = {}, None
    for p, d in zip(batch, data):
        daily = d["daily"]
        times = daily["time"]
        assert len(times) == RECENT_PAST_DAYS + 2, "hibás napszám"
        date = times[RECENT_PAST_DAYS]
        out[p["slug"]] = summarize_recent(times, daily["precipitation_sum"],
                                          daily["precipitation_probability_max"])
    return date, out


def fetch_recent(places, recent, limit=None):
    """Friss csapadékadat az összes (vagy az első `limit`) helyre, 50-es csomagokban.
    Bármilyen hibánál az EGÉSZ lekérés elvetődik: a korábbi fájl és az oldalak
    változatlanok maradnak (nincs félig friss állapot). True, ha sikerült."""
    targets = places[:limit] if limit else places
    print(f"friss csapadék: {len(targets)} hely lekérése", file=sys.stderr)
    got, date = {}, None
    try:
        for i in range(0, len(targets), RECENT_BATCH):
            if i:
                time.sleep(RECENT_SLEEP)
            d, out = fetch_recent_batch(targets[i:i + RECENT_BATCH])
            if date not in (None, d):
                raise ValueError("a csomagok napja eltér")
            date = d
            got.update(out)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, AssertionError) as err:
        print(f"friss csapadék: hiba ({err}), a korábbi adat marad", file=sys.stderr)
        return False
    if not got:
        return False
    new = {} if not limit else dict(recent["places"])
    for slug, v in got.items():
        v["water"] = recent["places"].get(slug, {}).get("water")
        if v["water"] is None:
            del v["water"]
        new[slug] = v
    recent["date"] = date
    recent["places"] = new
    save_recent(recent)
    return True


# ---------------------------------------------------------------------------
# Oldaltípusok (PAGE_BUILDERS)

def distance_km(a, b):
    r = 6371
    dlat = math.radians(b["lat"] - a["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a["lat"])) * math.cos(math.radians(b["lat"])) * math.sin(dlon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


def places_nav(places, heading="Települések"):
    items = "\n".join(
        f'      <li><a href="/eso/{p["slug"]}/">{esc(p["n"])}</a></li>' for p in places)
    return (f'    <nav aria-label="{esc(heading)}">\n'
            f'    <h2>{esc(heading)}</h2>\n'
            f'    <ul class="place-links">\n{items}\n    </ul>\n    </nav>')


def build_home(ctx):
    """A főoldal maga a sablon, csak a településlista generált. Mellé készül a
    /water-panel.html (a vízpanel markupja a generált oldalakhoz)."""
    alpha = sorted(ctx.places, key=lambda p: p["n"].casefold().translate(HU_SORT))
    html = replace_between(ctx.template, "places", places_nav(alpha))
    return [Page("/", html), Page("/water-panel.html", water_panel_fragment(ctx.template), indexable=False)]


# A magyar ábécé sorrendjéhez (ékezetes betűk az alapbetű után).
HU_SORT = str.maketrans({"á": "a~", "é": "e~", "í": "i~", "ó": "o~", "ö": "o~~",
                         "ő": "o~~~", "ú": "u~", "ü": "u~~", "ű": "u~~~"})


def climate_sentences(place, climate):
    c = climate["places"].get(place["slug"])
    if not c:
        return ""
    loc = place["loc"]
    annual = int(round(c["annual_mm"] / 10.0)) * 10
    month = MONTHS[c["wet_month"] - 1]
    return (f"{loc} az éves átlagos csapadék kb. {annual} mm "
            f"({climate['period']} átlaga). A legcsapadékosabb hónap a {month}, "
            f"átlagosan {c['wet_month_mm']} mm csapadékkal, és évente nagyjából "
            f"{c['rain_days']} napon esik legalább 1 mm.")


def embed_details(slug):
    """Összecsukható "Tedd ki az oldaladra" blokk a /widget/ iframe-kódjával."""
    code = (f'<iframe src="{BASE_URL}/widget/?hely={slug}" width="320" height="120" '
            f'style="border:0" loading="lazy" title="Esik most? (holazeso.hu)"></iframe>')
    return ("    <details class=\"about-details embed-box\">\n"
            "      <summary>Tedd ki az oldaladra</summary>\n"
            "      <p class=\"about\">Másold be ezt a kódot a saját weboldaladba: egy kicsi, "
            "világos és sötét módban is jól látszó doboz mutatja, esik-e most itt.</p>\n"
            f"      <textarea readonly rows=\"4\" aria-label=\"Beágyazó kód\" "
            f"onfocus=\"this.select()\" onclick=\"this.select()\">{esc(code)}</textarea>\n"
            "    </details>")


WEEKDAYS = ["hétfőn", "kedden", "szerdán", "csütörtökön", "pénteken", "szombaton", "vasárnap"]
# "nov. 3-án": a keltezés -án/-én toldaléka a nap számától függ (3-án, 4-én, 1-jén).
DAY_SUFFIX = {1: "jén", 2: "án", 3: "án", 4: "én", 5: "én", 6: "án", 7: "én", 8: "án", 9: "én",
              10: "én", 11: "én", 12: "én", 13: "án", 14: "én", 15: "én", 16: "án", 17: "én",
              18: "án", 19: "én", 20: "án", 21: "én", 22: "én", 23: "án", 24: "én", 25: "én",
              26: "án", 27: "én", 28: "án", 29: "én", 30: "án", 31: "én"}


def mm_hu(x):
    """Csapadék mm-ben: 10 mm fölött egész, alatta egy tizedes."""
    return num_hu(x, 0) if x >= 10 else num_hu(x, 1)


def recent_sentences(place, recent):
    """A tárolt friss adatból: elmúlt 7 nap + holnapi előrejelzés mondatai (üres, ha nincs adat)."""
    r = recent["places"].get(place["slug"])
    if not r or "week_mm" not in r:
        return []
    loc = place["loc"]
    out = []
    week = r["week_mm"]
    last = datetime.date.fromisoformat(r["last"]) if r.get("last") else None
    short = lambda d: f"{MONTHS[d.month - 1][:3]}. {d.day}."
    if week >= RAIN_DAY_MM:
        s = f"{loc} az elmúlt 7 napban {mm_hu(week)} mm csapadék hullott"
        if last:
            s += f", legutóbb {WEEKDAYS[last.weekday()]} ({short(last)}) esett"
        out.append(s + ".")
    else:
        if last:
            out.append(f"Az elmúlt 7 napban nem esett számottevő csapadék; "
                       f"legutóbb {short(last)[:-1]}-{DAY_SUFFIX[last.day]} esett.")
        else:
            out.append(f"Az elmúlt {RECENT_PAST_DAYS} napban nem esett legalább 1 mm csapadék.")
    prob, tmm = r.get("tomorrow_prob"), r.get("tomorrow_mm")
    if r.get("tomorrow") and (prob is not None or tmm is not None):
        d = datetime.date.fromisoformat(r["tomorrow"])
        bits = []
        if prob is not None:
            bits.append(f"{prob}% esély")
        if tmm is not None:
            bits.append(f"kb. {num_hu(tmm, 1)} mm" if tmm >= 0.1 else "érdemi csapadék nem várható")
        out.append(f"Holnapra ({short(d)}) " + ", ".join(bits) + ".")
    return out


def water_slug(kind, name):
    for sl, nm, _ in (RIVER_PAGES if kind == "river" else LAKE_PAGES):
        if nm == name:
            return sl
    return None


def nearest_gauge(place, water):
    """A legközelebbi (<= WATER_MAX_KM) folyó- vagy tóállomás a pillanatképből,
    ugyanazzal a szűréssel, mint a vízoldalak (EXCLUDE, elavult, nem szám)."""
    rivers, lakes = water
    best = None
    for kind, snap, key in (("river", rivers, "river"), ("lake", lakes, "lake")):
        for st in snap["stations"]:
            nm = st["name"] if kind == "river" else st["station"]
            if (nm in EXCLUDE or nm == "Balaton average" or st.get("stale")
                    or not isinstance(st.get("level_cm"), (int, float))
                    or not water_slug(kind, st[key])):
                continue
            km = distance_km(place, st)
            if km <= WATER_MAX_KM and (best is None or km < best[0]):
                best = (km, kind, st, nm)
    if not best:
        return None
    km, kind, st, nm = best
    wname = st["river" if kind == "river" else "lake"]
    return {"slug": water_slug(kind, wname), "water": wname,
            "station": STATION_LABEL.get(nm, nm), "km": int(round(km)), "level_cm": int(st["level_cm"])}


def update_recent_water(places, recent, water):
    """A vízpillanatkép elérhetőségekor frissíti a települések legközelebbi mércéjét."""
    for p in places:
        g = nearest_gauge(p, water)
        entry = recent["places"].setdefault(p["slug"], {})
        if g:
            entry["water"] = g
        else:
            entry.pop("water", None)
    save_recent(recent)


def gauge_sentence(place, recent):
    r = recent["places"].get(place["slug"])
    g = r.get("water") if r else None
    if not g:
        return ""
    return (f'A legközelebbi vízmérce: <a href="/vizallas/{g["slug"]}/">{esc(g["water"])}, '
            f'{esc(g["station"])}</a> ({g["km"]} km), ma {esc(cm_text(g["level_cm"]))}.')


def build_town_pages(ctx):
    pages = []
    for p in ctx.places:
        loc, slug = p["loc"], p["slug"]
        clim = climate_sentences(p, ctx.climate)
        near = sorted((q for q in ctx.places if q is not p), key=lambda q: distance_km(p, q))[:6]
        title = f"Esik most {loc}? Eső és radar | {SITE_NAME}"
        desc = (f"Esik most {loc}? Élő csapadékadat és radar: megmondjuk, esik-e, "
                f"és ha nem, hol esik a legközelebb.")
        if clim:
            desc += f" Éves csapadék: kb. {int(round(ctx.climate['places'][slug]['annual_mm'] / 10.0)) * 10} mm."
        h1 = f"Esik most {loc}?"
        rec = recent_sentences(p, ctx.recent)
        gauge = gauge_sentence(p, ctx.recent)
        content = [
            '  <section class="seo-content">',
            f'    <h2 class="seo-title">{esc(h1)}</h2>',
            '    <p class="about">',
            f"      Ez az oldal élő adatból megmondja, esik-e most {esc(loc)}, és ha nem,",
            "      megkeresi, hol esik a legközelebb: a település nevét, a távolságot,",
            "      az irányt és az eső erősségét is megmutatja, radarképpel együtt.",
            "      A <a href=\"/\">főoldalon</a> a saját helyedre is megnézheted.",
            "    </p>",
        ]
        if rec:
            content += ['    <p class="about">', f"      {esc(' '.join(rec))}", "    </p>"]
        if gauge:
            content += ['    <p class="about">', f"      {gauge}", "    </p>"]
        if clim:
            content += ['    <p class="about">', f"      {esc(clim)}", "    </p>"]
        content += [
            '    <p class="about">',
            "      A pillanatnyi csapadékot az Open-Meteo, a radarképet a RainViewer adja;",
            "      a sokéves átlagok az Open-Meteo ERA5 újraelemzéséből származnak.",
            "    </p>",
            places_nav(near, "Közeli települések"),
            embed_details(slug),
            "  </section>",
        ]
        boot = "window.HOLAZESO_PLACE = " + json.dumps(
            {"name": p["n"], "lat": p["lat"], "lon": p["lon"], "countryCode": "HU"},
            ensure_ascii=False, separators=(", ", ": ")) + ";"
        pages.append(render_page(
            ctx, path=f"/eso/{slug}/", title=title, description=desc, h1=h1,
            content_html="\n".join(content), boot_script=boot, q1=h1,
            slim_water=True))
    return pages



# ---------------------------------------------------------------------------
# Víz- és Cigánd-oldalak (2. fázis). Könnyű, közös tartalom-sablon: fejléc a
# főoldal-linkkel, szöveg, lábléc, ugyanaz a style.css; az esőalkalmazás nélkül.

WORKER = "https://holazeso-push-worker.kovizozi.workers.dev"
WATER_ORIGIN = "https://holazeso.hu"

# Kizárt állomások/tavak (név a pillanatképben). Az ellenőrzés (2026-11-24,
# hydroinfo.hu összevetés) mindet egyezőnek találta, ezért most üres; ide kell
# felvenni azt, aminek az értéke eltér a hivatalostól vagy nem ellenőrizhető.
EXCLUDE = set()

try:
    BUDAPEST = zoneinfo.ZoneInfo("Europe/Budapest")
except zoneinfo.ZoneInfoNotFoundError:
    BUDAPEST = datetime.timezone(datetime.timedelta(hours=1))

# slug, megjelenített név, "title" állomások sorrendje, kérdéses állomások helyhatározós alakja
RIVER_PAGES = [("duna", "Duna", ["Budapest", "Mohács", "Nagybajcs"]),
               ("tisza", "Tisza", ["Szeged", "Szolnok", "Tiszabecs", "Kisköre alsó"]),
               ("raba", "Rába", ["Győr"]),
               ("maros", "Maros", ["Makó"]),
               ("harmas-koros", "Hármas-Körös", ["Szarvas"]),
               ("drava", "Dráva", ["Drávaszabolcs", "Őrtilos"])]
LAKE_PAGES = [("balaton", "Balaton", ["Siófok", "Balatonakali", "Tihany rév"]),
              ("velencei-to", "Velencei-tó", ["Agárd"]),
              ("ferto", "Fertő", ["Fertőrákos"])]
STATION_LOC = {"Nagybajcs": "Nagybajcsnál", "Budapest": "Budapestnél", "Mohács": "Mohácsnál",
               "Győr": "Győrnél", "Tiszabecs": "Tiszabecsnél", "Kisköre alsó": "Kisköre alatt (alsó mérce)",
               "Szolnok": "Szolnoknál", "Szeged": "Szegednél", "Makó": "Makónál",
               "Szarvas": "Szarvasnál", "Őrtilos": "Őrtilosnál", "Drávaszabolcs": "Drávaszabolcsnál",
               "Siófok": "Siófoknál", "Balatonakali": "Balatonakalinál", "Tihany rév": "Tihany révnél",
               "Agárd": "Agárdnál", "Fertőrákos": "Fertőrákosnál",
               "Nagymaros": "Nagymarosnál", "Vásárosnamény": "Vásárosnaménynál"}
STATION_LABEL = {"Kisköre alsó": "Kisköre (alsó)", "Balaton average": "Balaton, átlag"}


def fetch_worker(name):
    req = urllib.request.Request(f"{WORKER}/{name}", headers={
        "Origin": WATER_ORIGIN, "User-Agent": "holazeso-build-pages"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def load_water(args):
    """(rivers, lakes) pillanatkép, vagy None, ha nincs kérés vagy hiba van: ilyenkor
    a meglévő vízoldalak érintetlenek maradnak, üres oldal sosem íródik."""
    try:
        if args.water_dir:
            d = Path(args.water_dir)
            rivers = json.loads((d / "rivers.json").read_text(encoding="utf-8"))
            lakes = json.loads((d / "lakes.json").read_text(encoding="utf-8"))
        elif args.fetch_water:
            rivers, lakes = fetch_worker("rivers-snapshot"), fetch_worker("lakes-snapshot")
        else:
            return None
        assert rivers["stations"] and lakes["stations"] and rivers["generated_at"]
        return rivers, lakes
    except (urllib.error.URLError, OSError, ValueError, KeyError, AssertionError) as err:
        print(f"víz: nem elérhető vagy hibás ({err}), a vízoldalak változatlanok", file=sys.stderr)
        return None


def parse_ts(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def hu_date(dt):
    dt = dt.astimezone(BUDAPEST)
    return f"{dt.year}. {MONTHS[dt.month - 1]} {dt.day}."


def cm_text(n):
    return f"mínusz {-n} cm" if n < 0 else f"{n} cm"


def cm_short(n):
    return f"{n} cm".replace("-", "−") if n < 0 else f"{n} cm"


def week_change(st):
    """A mostani érték változása ~7 nappal korábbihoz képest, vagy None, ha a
    history nem fedi le (a legrégebbi minta legfeljebb egy órával a cél után van)."""
    hist = st.get("history") or []
    if len(hist) < 2:
        return None
    last = parse_ts(hist[-1]["at"])
    target = last - datetime.timedelta(days=7)
    if parse_ts(hist[0]["at"]) > target + datetime.timedelta(hours=1):
        return None
    base = min(hist, key=lambda h: abs((parse_ts(h["at"]) - target).total_seconds()))
    return st["level_cm"] - base["level_cm"]


def change_phrase(delta):
    if delta is None:
        return ""
    if delta == 0:
        return ", ugyanannyi, mint egy hete"
    return f", {abs(delta)} cm-rel {'magasabb' if delta > 0 else 'alacsonyabb'}, mint egy hete"


FOOTER_NAV = ('    <nav class="footer-nav" aria-label="Oldalak"><a href="/">Hol esik most?</a> · '
              '<a href="/ho/">Hol esik a hó?</a> · <a href="/vizallas/">Vízállás ma</a> · '
              '<a href="/cigand/">Cigánd</a> · <a href="/eghajlat/">Éghajlat 1901 óta</a> · '
              '<a href="/az-oldalrol/">Az oldalról</a></nav>\n')


def doc_page(ctx, *, path, title, description, h1, body_html, extra_scripts=""):
    """Könnyű szöveges oldal: a sablon feje (meta, style.css), saját törzs.
    extra_scripts: a GoatCounter elé kerülő saját script-címkék."""
    page = render_page(ctx, path=path, title=title, description=description, h1=h1,
                       content_html="")
    head = page.html[:page.html.index("<body>")]
    html = (head + '<body class="doc">\n'
            '  <header class="doc-top"><a class="doc-home" href="/">hol az eső?</a>\n'
            '    <nav aria-label="Oldalak"><a href="/vizallas/">Vízállás</a> '
            '<a href="/cigand/">Cigánd</a> <a href="/eghajlat/">Éghajlat</a></nav></header>\n'
            '  <main class="doc-main">\n' + body_html + '\n  </main>\n'
            '  <footer>\n' + FOOTER_NAV + '    <p class="credits">holazeso.hu · <a href="/">Hol esik most?</a> · '
            'Vízállás: <a href="https://www.hydroinfo.hu/" target="_blank" rel="noopener">hydroinfo.hu</a> '
            '(Országos Vízügyi Főigazgatóság)</p>\n  </footer>\n'
            + extra_scripts +
            '  <script data-goatcounter="https://holazeso.goatcounter.com/count"\n'
            '          async src="//gc.zgo.at/count.js"></script>\n</body>\n</html>\n')
    return Page(path, html)


# --- Vízállás: adatok és grafikonok (water-history.json, water-alerts.json) ---
# A grafikont a /vizallas.js rajzolja a data/vizallas/<allomas>.json-ból; a HTML-ben a szöveges
# összefoglaló marad (keresők, JS nélkül), a grafikon helye aspect-ratio-val előre foglalt.
HISTORY_FILE = ROOT / "water-history.json"
ALERTS_FILE = ROOT / "water-alerts.json"
VIZALLAS_JS = "/vizallas.js?v=9"
DATA_DIR = "data/vizallas"
# oldal-állomás neve -> archívum-kód (éves sor és napi sor)
HIST_CODE = {"Siófok": "si", "Agárd": "ag", "Budapest": "bp", "Mohács": "mo", "Szolnok": "so",
             "Szeged": "se", "Nagymaros": "nm", "Vásárosnamény": "vn", "Fertőrákos": "fe",
             "Nagybajcs": "nb", "Tiszabecs": "tb", "Kisköre alsó": "ka", "Szarvas": "sz"}
# napi sor: a Balaton-mércéknek nincs saját táblájuk, a Balaton átlag ("ba") sorát használják
DAILY_CODE = dict(HIST_CODE, **{"Siófok": "ba", "Balatonakali": "ba", "Tihany rév": "ba"})
HIST_ONLY_AFTER = {"Duna": [("Budapest", "Nagymaros")], "Tisza": [("Szolnok", "Vásárosnamény")]}
SHORT_MONTHS = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.",
                "okt.", "nov.", "dec."]
HIST_ALT_SRC = {"balaton-avg", "bgld"}      # más mérésből származó évek (sraffozott sáv)
SRC_TEXT = "hydroinfo.hu (OVF)"
WATER_JS_FILE = ROOT / "water.js"


def load_history():
    try:
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8")).get("stations") or {}
    except (OSError, ValueError):
        return {}


def load_alerts():
    try:
        return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"stations": {}, "lake_limits": {}}


def hu_iso_date(iso, short=False, day=True):
    y, m, d = (int(p) for p in iso.split("-"))
    name = SHORT_MONTHS[m - 1] if short else MONTHS[m - 1]
    return f"{y}. {name} {d}." if day else f"{y}. {name}"


UNACCENT = str.maketrans({"á": "a", "é": "e", "í": "i", "ó": "o", "ö": "o", "ő": "o",
                          "ú": "u", "ü": "u", "ű": "u"})


def station_slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower().translate(UNACCENT)).strip("-")


def history_extremes(hst):
    """A valaha mért legalacsonyabb és legmagasabb érték (a Balaton-átlagos évek nélkül)."""
    data = hst.get("years") or {}
    pool = [(y, v) for y, v in data.items() if v.get("src") != "balaton-avg"]
    if not pool:
        return None
    emin = min(pool, key=lambda kv: (kv[1]["min"], kv[1]["min_date"]))[1]
    emax = max(pool, key=lambda kv: (kv[1]["max"], -int(kv[1]["max_date"].replace("-", ""))))[1]
    return {"min": [emin["min"], emin["min_date"], emin["src"]],
            "max": [emax["max"], emax["max_date"], emax["src"]],
            "first": min(int(y) for y, _ in pool)}


def years_rows(hst):
    """Évenként [év, min, "HH-NN", max, "HH-NN", átlag, napszám, jelzők] (1: más forrás, 2: nem teljes év)."""
    rows = []
    for y, v in sorted((hst.get("years") or {}).items(), key=lambda kv: int(kv[0])):
        flags = (1 if v.get("src") in HIST_ALT_SRC else 0) | (2 if v.get("partial") else 0)
        rows.append([int(y), v["min"], v["min_date"][5:], v["max"], v["max_date"][5:],
                     round(v["mean"], 1), v["n"], flags])
    return rows


def history_notes(hst, now_year):
    data = hst.get("years") or {}
    yrs = sorted(int(y) for y in data)
    first, last = yrs[0], yrs[-1]
    srcs = {v.get("src") for v in data.values()}
    notes = ["Forrás: hydroinfo.hu, Központi Hidrológiai Adattár (OVF), nyers adat"
             + ("; 1965 és 2001 között az osztrák (burgenlandi) vízügy tószint-adataiból átszámítva, "
                "kb. ±3 cm pontossággal (sraffozott sáv)" if "bgld" in srcs else "")
             + ". Napi reggeli (7 órás) mérések alapján, a hivatalos rekordtól néhány cm-rel eltérhet. "
             f"A sáv az időszak (év, 5 év vagy évtized) legalacsonyabb és legmagasabb napi értéke között húzódik, a vonal az átlag. "
             f"Lefedett évek: {first}-{last}" + (" (2002-től az újabb táblákból)" if "hydroinfo-archive" not in srcs else "") + "."]
    if "balaton-avg" in srcs:
        ay = sorted(int(y) for y, v in data.items() if v.get("src") == "balaton-avg")
        notes.append(f"{ay[0]}-től a Balaton átlagos vízállása (Siófok-adat nem elérhető), átlagosan kb. "
                     "3 cm-rel tér el (sraffozott sáv); a szélsőértékek csak a siófoki évekből valók.")
    for y, v in sorted(data.items()):
        if v.get("partial"):
            notes.append(f"{y}: az év eleje óta, {hu_iso_date(v['through'], short=True).rstrip('.')}-ig "
                         "(szaggatott vonal).")
    gaps = [y for y in range(first, last + 1) if str(y) not in data]
    if gaps:
        notes.append("Hiányzó évek: " + ", ".join(str(g) for g in gaps) + ".")
    if last < now_year:
        notes.append(f"A {last} utáni évek feltöltése folyamatban.")
    zc = hst.get("zero_changes") or []
    if zc and max(abs(c["zero_m"] - hst["zero_m"]) for c in zc) * 100 > 2.5:
        hu = lambda x: str(round(x, 2)).replace(".", ",")
        parts = "; ".join(f"{c['from'] if c['from'] == c['to'] else str(c['from']) + '-' + str(c['to'])}: "
                          f"{hu(c['zero_m'])} m" for c in zc)
        notes.append(f"A régebbi éveket a mérce mostani nullpontjára ({hu(hst['zero_m'])} m Bf) számoltuk át "
                     f"(korábbi nullpont: {parts}).")
    return notes


def records_sentence(loc, hst):
    ext = history_extremes(hst)
    if not ext or len(hst.get("years") or {}) < 3:
        return ""
    lo_v, lo_d, _ = ext["min"]
    hi_v, hi_d, _ = ext["max"]
    tag = lambda k: ", osztrák adat" if ext[k][2] == "bgld" else ""
    return (f"A mérések {ext['first']} óta a legalacsonyabb vízállás {loc} {cm_text(lo_v)} volt "
            f"({hu_iso_date(lo_d)}{tag('min')}), a legmagasabb {cm_text(hi_v)} "
            f"({hu_iso_date(hi_d)}{tag('max')}).")


def hourly_pack(hist):
    """Óránkénti history: {"t0": ISO UTC (perc), "dt": [percek t0-tól], "cm": [...]}."""
    if not hist or len(hist) < 3:
        return None
    t0 = parse_ts(hist[0]["at"]).astimezone(datetime.timezone.utc).replace(second=0, microsecond=0)
    dt = [round((parse_ts(h["at"]) - t0).total_seconds() / 60) for h in hist]
    return {"t0": t0.strftime("%Y-%m-%dT%H:%MZ"), "dt": dt, "cm": [h["level_cm"] for h in hist]}


def station_json(*, slug, nm, kind, wname, wslug, st, gen, hst, dst, alerts, label_loc):
    """Egy állomás grafikon-adata (data/vizallas/<slug>.json). Minden rész opcionális."""
    out = {"v": 1, "slug": slug, "name": STATION_LABEL.get(nm, nm), "water": wname, "wslug": wslug,
           "kind": kind, "loc": label_loc, "source": SRC_TEXT}
    if st is not None:
        out["now"] = {"cm": st["level_cm"], "at": gen.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
        out["snap"] = {"river": st["river"], "name": st["name"]} if kind == "river" else None
        if not out["snap"]:
            del out["snap"]
        hp = hourly_pack(st.get("history")) if kind == "river" else None
        if hp:
            out["hourly"] = hp
        fc = st.get("forecast_cm") if kind == "river" else None
        if fc:
            # forecast_cm[i]: a gen napját követő (1 + i.) nap 07:00-ra (helyi idő) szóló előrejelzés
            d0 = gen.astimezone(BUDAPEST).date() + datetime.timedelta(days=1)
            out["forecast"] = {"t0": d0.isoformat(), "cm": fc}
    if dst and dst.get("daily"):
        out["daily"] = dst["daily"]
        if DAILY_CODE.get(nm) == "ba":
            out["daily_note"] = ("A napi adat a Balaton átlagos vízállása (ennek a mércének nincs "
                                 "saját napi táblája).")
    if hst and len(hst.get("years") or {}) >= 3:
        out["years"] = years_rows(hst)
        out["ever"] = history_extremes(hst)
        out["notes"] = history_notes(hst, gen.year)
    al = alerts["stations"].get(nm)
    if al and kind == "river":
        out["alerts"] = {"levels": al["levels"], "lnv": al["lnv"]}
        if al.get("note"):
            out["alerts"]["note"] = al["note"]
    lim = alerts.get("lake_limits", {}).get(nm)
    if lim and kind == "lake":
        out["limit"] = {"cm": lim["cm"], "label": lim["label"]}
    return out


# --- Térkép (a water.js folyóhálózat-ábrájának geometriája, 400 x 250-es sematikus rajz) ---
MAP_W, MAP_H = 400, 250
MAP_RIVER_PAGE = {"Duna": "duna", "Tisza": "tisza", "Rába": "raba", "Maros": "maros",
                  "Körösök": "harmas-koros", "Dráva": "drava"}
MAP_LAKE_PAGE = {0: "balaton", 1: "ferto"}          # a tavak sorrendje a WATER_RIVER_NET_SVG-ben
# lon/lat -> a rajz x/y-ja (a Balaton körvonalának keretéből illesztve)
MAP_X0, MAP_LON0, MAP_SX = 74.0, 17.25, 56.5
MAP_Y0, MAP_LAT0, MAP_SY = 132.0, 47.06, 83.0
_MAP_CACHE = []


def map_geo():
    """(határ, külföldi szakaszok, tavak, folyók) a water.js WATER_RIVER_NET_SVG-jéből, a
    RIVER_NET_PATHS névsorrendjével. Egyetlen forrás: ha a water.js ábrája változik, a térkép is."""
    if _MAP_CACHE:
        return _MAP_CACHE[0]
    src = WATER_JS_FILE.read_text(encoding="utf-8")
    svg = re.search(r"const WATER_RIVER_NET_SVG = `(.*?)`;", src, re.S).group(1)
    paths = [d for _, d in re.findall(r'<path([^>]*?)d="([^"]+)"', svg)]
    block = re.search(r"const RIVER_NET_PATHS = \[(.*?)\];", src, re.S).group(1)
    names = re.findall(r'\["([^"]+)", (?:null|\d+), (?:true|false)\]', block)
    assert len(paths) == 12 + len(names) and len(names) == 17, "water.js folyóhálózat-ábra"
    geo = (paths[0], paths[1:9], paths[9:12], list(zip(names, paths[12:])))
    _MAP_CACHE.append(geo)
    return geo


def map_xy(lat, lon):
    return MAP_X0 + (lon - MAP_LON0) * MAP_SX, MAP_Y0 + (MAP_LAT0 - lat) * MAP_SY


def water_map(active, points, labels=True):
    """Statikus SVG-térkép: minden folyó/tó szürke és kattintható (<a>), az aktuális víz --accent.
    active: a víz slugja (None: mindegyik kiemelve, áttekintő). points: [(név, lat, lon, slug)]."""
    border, foreign, lakes, rivers = map_geo()
    out = [f'<svg class="vz-map{" vz-map-all" if active is None else ""}" viewBox="0 0 {MAP_W} {MAP_H}" role="group" '
           f'aria-label="Magyarország folyói és tavai, kattintható térkép">',
           f'<path class="vz-map-border" d="{border}"/>',
           '<g class="vz-map-foreign">' + "".join(f'<path d="{d}"/>' for d in foreign) + "</g>"]
    names_of = {}
    for name, d in rivers:
        names_of.setdefault(name, []).append(d)
    # nem linkelt (nincs oldalunk) folyók: szürke, vékony
    out.append('<g class="vz-map-other">' + "".join(
        f'<path d="{d}"/>' for name, ds in names_of.items() if name not in MAP_RIVER_PAGE for d in ds)
        + f'<path d="{lakes[2]}"/></g>')
    items = [(MAP_RIVER_PAGE[n], n, ds, "river") for n, ds in names_of.items() if n in MAP_RIVER_PAGE]
    items += [(MAP_LAKE_PAGE[i], LAKE_NAME[MAP_LAKE_PAGE[i]], [lakes[i]], "lake") for i in MAP_LAKE_PAGE]
    # az aktuális víz kerül utoljára (felülre)
    items.sort(key=lambda it: it[0] == active)
    for sl, name, ds, kind in items:
        cls = "vz-map-water" + (" is-active" if sl == active else "") + (" is-lake" if kind == "lake" else "")
        ds_html = "".join(f'<path class="vz-map-line" d="{d}"/><path class="vz-map-hit" d="{d}"/>' for d in ds)
        cur = ' aria-current="page"' if sl == active else ""
        out.append(f'<a class="{cls}" href="/vizallas/{sl}/" data-name="{esc(name)}" '
                   f'aria-label="{esc(name)}"{cur}>'
                   f'<title>{esc(name)}</title>{ds_html}</a>')
    # Velencei-tó: nincs a rajzon, csak jelölő
    for pname, lat, lon, sl, tip in points:
        x, y = map_xy(lat, lon)
        on = sl == active
        mark = (f'<a class="vz-map-pt{" is-active" if on else ""}" href="/vizallas/{sl}/" data-name="{esc(tip)}" '
                f'aria-label="{esc(tip)}"><title>{esc(tip)}</title>'
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{3.2 if on else 2.2}"/>'
                f'<circle class="vz-map-hit" cx="{x:.1f}" cy="{y:.1f}" r="7"/>')
        if labels and on:
            right = x < MAP_W * 0.75
            mark += (f'<text x="{x + (5 if right else -5):.1f}" y="{y + 3:.1f}" '
                     f'text-anchor="{"start" if right else "end"}">{esc(pname)}</text>')
        out.append(mark + "</a>")
    out.append("</svg>")
    legend = ("teli pont: ezen a vízen lévő mérőállomás, üres pont: más vizek állomásai; kattints egy vízre"
              if active else "pont: mérőállomás; kattints egy folyóra vagy tóra")
    return "".join(out) + f'<figcaption class="vz-maplegend">{legend}</figcaption>'


LAKE_NAME = {sl: nm for sl, nm, _ in LAKE_PAGES}


def water_gauge_points(snap_rivers, snap_lakes):
    """[(megjelenített név, lat, lon, a víz slugja)] az élő állomásokból + a csak archív Nagymaros és
    Vásárosnamény, Velencei-tó."""
    pts = []
    for st in snap_rivers["stations"]:
        sl = water_slug("river", st["river"])
        if sl and not st.get("stale"):
            pts.append((STATION_LABEL.get(st["name"], st["name"]), st["lat"], st["lon"], sl,
                        f'{st["river"]}, {STATION_LABEL.get(st["name"], st["name"])}: {cm_short(st["level_cm"])}'))
    for st in snap_lakes["stations"]:
        sl = water_slug("lake", st["lake"])
        if sl and st["station"] != "Balaton average" and not st.get("stale"):
            pts.append((STATION_LABEL.get(st["station"], st["station"]), st["lat"], st["lon"], sl,
                        f'{st["lake"]}, {STATION_LABEL.get(st["station"], st["station"])}: {cm_short(st["level_cm"])}'))
    pts.append(("Nagymaros", 47.7833, 18.9500, "duna", "Duna, Nagymaros"))
    pts.append(("Vásárosnamény", 48.1333, 22.3167, "tisza", "Tisza, Vásárosnamény"))
    return pts


def water_stations(snapshot, names, key):
    by = {}
    for st in snapshot["stations"]:
        nm = st["name"] if key == "river" else st["station"]
        if nm in EXCLUDE or st.get("stale") or not isinstance(st.get("level_cm"), (int, float)):
            continue
        by.setdefault(st[key], {})[nm] = st
    return by


def chart_figure(slug, chart, title, fallback, data_hash, single):
    """A grafikon helye: a vizallas.js tölti. A keret aspect-ratio-ja és a vezérlősor magassága
    előre foglalt (nincs elmozdulás), JS nélkül a szöveges összefoglaló látszik."""
    return (f'      <figure class="vz-fig" data-vz-station="{slug}" data-vz-chart="{chart}" '
            f'data-vz-src="/{DATA_DIR}/{slug}.json?h={data_hash}">\n'
            f'        <div class="vz-bar"><h3 class="vz-title">{esc(title)}</h3></div>\n'
            f'        <div class="vz-ctl"></div>\n'
            f'        <div class="vz-frame"><p class="vz-fallback">{esc(fallback)}</p></div>\n'
            f'      </figure>')


def friss_fallback(st, kind):
    hist = (st or {}).get("history") or []
    if kind == "river" and len(hist) >= 3:
        vals = [h["level_cm"] for h in hist]
        first, last = parse_ts(hist[0]["at"]), parse_ts(hist[-1]["at"])
        days = max(1, round((last - first).total_seconds() / 86400))
        return (f"Elmúlt {days} nap: legalacsonyabb {cm_short(min(vals))}, legmagasabb {cm_short(max(vals))}, "
                f"most {cm_short(st['level_cm'])}. Az interaktív grafikonhoz JavaScript kell.")
    return "Az interaktív grafikonhoz JavaScript kell."


def build_water_pages(ctx):
    if not ctx.water:
        return []
    rivers, lakes = ctx.water
    gen = parse_ts(rivers["generated_at"])
    date = hu_date(gen)
    history = load_history()
    alerts = load_alerts()
    river_by = water_stations(rivers, None, "river")
    lake_by = water_stations(lakes, None, "lake")
    gauge_pts = water_gauge_points(rivers, lakes)
    src_p = (f'<p class="doc-note">Forrás: <a href="https://www.hydroinfo.hu/" target="_blank" '
             f'rel="noopener">hydroinfo.hu</a>, Országos Vízügyi Főigazgatóság. Állás: {date} '
             f'A holazeso.hu adatgyűjtője óránként tölti le; a vízállás az adott mérce saját '
             f'0 pontjához mért centiméter, nem tengerszint feletti magasság.</p>')
    pages, overview_rows = [], []
    nav_links = " · ".join(f'<a href="/vizallas/{sl}/">{esc(nm)}</a>'
                           for sl, nm, _ in RIVER_PAGES + LAKE_PAGES)
    done = set()

    def station_section(nm, kind, wname, wslug, st, order_h2=None):
        """(html, rövid mondat) egy állomás szekciója; az adatfájl a ctx.files-ba kerül."""
        slug = station_slug(nm)
        loc = STATION_LOC.get(nm, nm)
        hst = history.get(HIST_CODE.get(nm), {}) if nm in HIST_CODE else {}
        dst = history.get(DAILY_CODE.get(nm), {}) if nm in DAILY_CODE else {}
        data = station_json(slug=slug, nm=nm, kind=kind, wname=wname, wslug=wslug, st=st, gen=gen,
                            hst=hst, dst=dst, alerts=alerts, label_loc=loc)
        has_any = any(k in data for k in ("hourly", "daily", "years"))
        sec = [f'    <section class="vz-station" id="{slug}">\n      <h2>{esc(STATION_LABEL.get(nm, nm))}</h2>']
        if st is not None:
            lv = st["level_cm"]
            delta = week_change(st) if kind == "river" else None
            sentence = f"A {wname} vízállása {loc} ma {cm_text(lv)}{change_phrase(delta)}."
            sec.append(f'      <p class="vz-sentence">{esc(sentence)}</p>')
        rec = records_sentence(loc, hst) if hst else ""
        if rec:
            sec.append(f'      <p class="vh-text">{esc(rec)}</p>')
        if has_any:
            text = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
            h = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
            ctx.files[f"{DATA_DIR}/{slug}.json"] = text
            done.add(slug)
            sec.append(chart_figure(slug, "friss", f"Vízállás: {STATION_LABEL.get(nm, nm)}",
                                    friss_fallback(st, kind), h, False))
            if data.get("daily_note"):
                sec.append(f'      <p class="doc-note">{esc(data["daily_note"])}</p>')
            if "years" in data:
                sec.append(chart_figure(slug, "hossz", f"Éves vízállás-tartomány: {STATION_LABEL.get(nm, nm)}",
                                        "Az évenkénti legalacsonyabb, átlagos és legmagasabb vízállás interaktív "
                                        "grafikonjához JavaScript kell.", h, False))
                sec.append(f'      <p class="doc-note">{esc(" ".join(data["notes"]))}</p>')
            if "alerts" in data:
                lv3 = data["alerts"]["levels"]
                lnv = data["alerts"]["lnv"]
                note = (f"Készültségi szintek ({STATION_LABEL.get(nm, nm)}): I. fok {lv3[0]} cm, II. fok {lv3[1]} cm, "
                        f"III. fok {lv3[2]} cm; hivatalos legnagyobb vízállás (LNV): {lnv[0]} cm, "
                        f"{hu_iso_date(lnv[1], short=True)} Forrás: 10/1997. (V. 28.) KHVM rendelet.")
                if data["alerts"].get("note"):
                    note += " " + data["alerts"]["note"]
                sec.append(f'      <p class="doc-note">{esc(note)}</p>')
        sec.append("    </section>")
        return "\n".join(sec)

    def build(kind, sl, name, order):
        group = (river_by if kind == "river" else lake_by).get(name, {})
        stations = [group[n] for n in order if n in group]
        if kind == "lake":
            stations += [st for n, st in group.items() if n not in order and n != "Balaton average"]
        if not stations:
            return
        titles, desc_bits, sections = [], [], []
        for st in stations:
            nm = st["name"] if kind == "river" else st["station"]
            lv = st["level_cm"]
            delta = week_change(st) if kind == "river" else None
            sections.append(station_section(nm, kind, name, sl, st))
            for after, hnm in (HIST_ONLY_AFTER.get(name, []) if kind == "river" else []):
                if after == nm:
                    sections.append(station_section(hnm, kind, name, sl, None))
            titles.append(nm)
            desc_bits.append(f"{STATION_LABEL.get(nm, nm)} {cm_short(lv)}")
            overview_rows.append((kind, sl, name, STATION_LABEL.get(nm, nm), lv, delta))
        avg = group.get("Balaton average")
        if avg:
            sections.append(f'    <p class="vz-sentence">A Balaton átlagos vízállása ma '
                            f'{esc(cm_text(avg["level_cm"]))}.</p>')
        ttl_names = ", ".join(titles[:3])
        title = f"{name} vízállás ma: {ttl_names} | {SITE_NAME}"
        desc = (f"A {name} vízállása ma: {'; '.join(desc_bits[:3])}. "
                + ("Változás egy hét alatt, interaktív grafikon, készültségi szintek, forrás: hydroinfo.hu."
                   if kind == "river" else "Interaktív grafikon, forrás: hydroinfo.hu, mérési dátummal."))
        h1 = f"{name} vízállás ma"
        body = (f'    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a> / '
                f'<a href="/vizallas/">Vízállás</a></nav>\n    <h1>{esc(h1)}</h1>\n'
                f'    <figure class="vz-mapfig">{water_map(sl, gauge_pts)}</figure>\n'
                + "\n".join(sections) + "\n    " + src_p
                + f'\n    <p class="doc-more">Más folyók és tavak: {nav_links}.</p>')
        pages.append(doc_page(ctx, path=f"/vizallas/{sl}/", title=title, description=desc,
                              h1=h1, body_html=body,
                              extra_scripts=f'  <script src="{VIZALLAS_JS}" defer></script>\n'))

    for sl, nm, order in RIVER_PAGES:
        build("river", sl, nm, order)
    for sl, nm, order in LAKE_PAGES:
        build("lake", sl, nm, order)
    if not pages:
        return []

    rows = []
    for kind, sl, name, label, lv, delta in overview_rows:
        if kind == "river":
            ch = "" if delta is None else ("0" if delta == 0 else f"{'+' if delta > 0 else '−'}{abs(delta)}")
        else:
            ch = ""
        rows.append(f'        <tr><th scope="row"><a href="/vizallas/{sl}/">{esc(name)}</a>, '
                    f'{esc(label)}</th><td>{cm_short(lv)}</td><td>{ch}</td></tr>')
    h1 = "Vízállás ma: folyók és tavak"
    body = (f'    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a></nav>\n'
            f'    <h1>{h1}</h1>\n'
            f'    <p class="vz-sentence">Ma, {esc(date)} a Duna vízállása Budapestnél '
            f'{cm_text(river_by["Duna"]["Budapest"]["level_cm"]) if "Budapest" in river_by.get("Duna", {}) else "nem ismert"}'
            f', a Balatoné Siófoknál {cm_text(lake_by["Balaton"]["Siófok"]["level_cm"]) if "Siófok" in lake_by.get("Balaton", {}) else "nem ismert"}.'
            f' Az alábbi térképen és táblázatban a magyarországi folyók és nagy tavak mérőállomásai; kattints '
            f'egy folyóra vagy tóra a részletekért. A folyóknál az egy hete mért értékhez is hasonlítunk.</p>\n'
            f'    <figure class="vz-mapfig">{water_map(None, gauge_pts, labels=False)}</figure>\n'
            f'    <table class="vz-table">\n      <thead><tr><th scope="col">Víz, mérőállomás</th>'
            f'<th scope="col">Vízállás</th><th scope="col">7 nap alatt (cm)</th></tr></thead>\n'
            f'      <tbody>\n' + "\n".join(rows) + '\n      </tbody>\n    </table>\n    ' + src_p
            + f'\n    <p class="doc-more">Részletek: {nav_links}. '
              f'<a href="/cigand/">Mi történt Cigándnál?</a></p>')
    pages.insert(0, doc_page(
        ctx, path="/vizallas/", title=f"Vízállás ma: Duna, Tisza, Balaton | {SITE_NAME}",
        description=("Magyar folyók és tavak vízállása ma: Duna, Tisza, Rába, Maros, Körös, Dráva, "
                     "Balaton, Velencei-tó, Fertő. Változás egy hét alatt, forrás: hydroinfo.hu."),
        h1=h1, body_html=body, extra_scripts=f'  <script src="{VIZALLAS_JS}" defer></script>\n'))
    pages.append(build_embed_page(ctx))
    return pages


def build_embed_page(ctx):
    """/beagyaz/vizallas/?allomas=<slug>&grafikon=friss|hossz&nezet=<szűrő>: iframe-be szánt,
    önálló oldal (noindex). A grafikont a vizallas.js tölti a data/vizallas/<slug>.json-ból."""
    page = render_page(ctx, path="/beagyaz/vizallas/", title=f"Vízállás grafikon | {SITE_NAME}",
                       description="Beágyazható vízállás-grafikon.", h1="Vízállás grafikon",
                       content_html="", indexable=False)
    head = page.html[:page.html.index("<body>")]
    html = (head + '<body class="vz-embed">\n'
            '  <main class="vz-embed-main" id="vz-embed"><noscript><p>A grafikonhoz JavaScript kell.</p></noscript></main>\n'
            '  <footer class="vz-embed-foot">Forrás: hydroinfo.hu (OVF) · '
            '<a href="https://holazeso.hu/" target="_blank" rel="noopener">holazeso.hu</a></footer>\n'
            f'  <script src="{VIZALLAS_JS}" defer></script>\n</body>\n</html>\n')
    return Page("/beagyaz/vizallas/", html, indexable=False)


def hu_short_date(text):
    dt = parse_ts(text).astimezone(BUDAPEST)
    return f"{MONTHS[dt.month - 1][:3]}. {dt.day}."


def num_hu(x, digits=1):
    return f"{x:.{digits}f}".replace(".", ",").rstrip("0").rstrip(",") if digits else str(int(x))


CIGAND_FIGURES = """    <div id="cigand-figures">
    <h2>Hová jut a víz?</h2>
    <figure class="water-figure fig-medium cigand-figure" id="cigand-figure" style="--ar: 1.2">
      <svg id="cigand-map" viewBox="0 0 640 533" preserveAspectRatio="xMidYMid meet" role="group" aria-label="a cigándi tározó vázlatos térképe"></svg>
      <div id="cigand-tooltip" class="water-map-tooltip" hidden></div>
      <span class="cigand-badge" id="cigand-badge">szemléltető ábra, nem élő mérés</span>
      <figcaption>
        <p class="cigand-badge-line" id="cigand-badge-line" hidden>szemléltető ábra, nem élő mérés</p>
        <p class="cigand-step-caption" id="cigand-step-caption" aria-live="polite"></p>
        <div class="cigand-controls">
          <span class="cigand-dots" id="cigand-dots" role="group" aria-label="az animáció lépései"></span>
          <button type="button" class="link-btn" id="cigand-replay">lejátszás újra</button>
        </div>
      </figcaption>
    </figure>
    <ol class="cigand-steps" id="cigand-steps" hidden></ol>
    <h2>Mennyi fér bele, és mennyi van benne?</h2>
    <figure class="water-figure fig-medium cigand-figure" style="--ar: 1.259">
      <svg id="cigand-section-svg" viewBox="0 0 720 572" preserveAspectRatio="xMidYMid meet" role="img" aria-label="a cigándi tározó vázlatos függőleges metszete: a Tisza, az árvédelmi gát, a zsilip, a tározó feneke a vápával; teli állapotban 94 millió köbméter, most közel 2 millió"></svg>
      <figcaption>A magasság erősen túlozva; nem mért vízszint, a bejelentett mennyiségből számolva. <span class="cigand-chip">számolt</span></figcaption>
    </figure>
    <dl class="cigand-xs-list" id="cigand-xs-list" hidden></dl>
    </div>"""
CIGAND_PAGE_JS = "/cigand-page.js?v=3"


def bold_md(text):
    """A cigand.json **kiemelés** jelölése <strong>-gá (az escape UTÁN hívandó)."""
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)


def build_cigand_page(ctx):
    cg = json.loads((ROOT / "cigand.json").read_text(encoding="utf-8"))
    nf = ROOT / "cigand-news.json"
    news = json.loads(nf.read_text(encoding="utf-8")) if nf.exists() else {}
    f = cg["facts"]
    mm = lambda v: num_hu(v / 1e6, 1)
    facts = [
        f"A tározó 2008-ban készült, {num_hu(f['area_km2'])} km² területű, legfeljebb "
        f"{mm(f['capacity_m3'])} millió m³ víz fér bele, átlagos mélysége {num_hu(f['mean_depth_m'])} m.",
        f"A gátja {num_hu(f['dyke_km'])} km hosszú és {num_hu(f['dyke_height_m'])} m magas; "
        f"a zsilip {f['gate_width_m']} m széles.",
        f"Most kb. {mm(f['volume_m3'])} millió m³ vizet engednek be (a miniszterelnök {mm(f['volume_m3'])}-"
        f"{mm(f['volume_high_m3'])} milliót mondott), ez a kapacitásnak töredéke.",
    ]
    ex = lambda src: (f' (<a href="{esc(src["url"])}" target="_blank" rel="noopener">{esc(src["name"])}</a>)'
                      if src else "")
    kind = lambda k: f' <span class="cg-kind">{esc(k)}</span>' if k else ""
    tl = "\n".join(
        f'      <li><span class="cg-date">{esc(t["date"])}</span> {esc(t["text"])}{ex(t.get("source"))}'
        f'{kind(t.get("kind"))}</li>' for t in cg["timeline"])
    faq = "\n".join(
        f'      <dt>{esc(q["q"])}</dt>\n      <dd>{bold_md(esc(q["a"]))}{ex(q.get("source"))}{kind(q.get("kind"))}</dd>'
        for q in cg.get("faq", []))
    parts = [f'    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a></nav>',
             f'    <h1>{esc(cg["title"])}</h1>',
             f'    <p class="vz-sentence">{esc(cg["lead"])}</p>']
    ls = news.get("latest_status")
    if ls and isinstance(ls.get("stored_volume_m3"), (int, float)) \
            and (ls.get("fact_date") or ls.get("when") or "") > f["date"]:
        parts.append(f'    <p class="doc-note">Legfrissebb hír szerint: kb. {mm(ls["stored_volume_m3"])} millió m³ '
                     f'(<a href="{esc(ls["link"])}" target="_blank" rel="noopener">{esc(ls["source"])}</a>, '
                     f'{hu_short_date((ls.get("fact_date") or ls["when"]) + "T12:00:00Z")})</p>')
    parts.append(CIGAND_FIGURES)
    parts += ['    <h2>A tározó adatai</h2>', "    <ul class=\"cg-list\">"
              + "".join(f"\n      <li>{esc(x)}</li>" for x in facts) + "\n    </ul>",
              '    <h2>Időrend</h2>', f'    <ul class="cg-list">\n{tl}\n    </ul>']
    if faq:
        parts += ['    <h2>Amit érdemes tudni</h2>', f'    <dl class="cg-faq">\n{faq}\n    </dl>']
    items = [it for it in news.get("items", []) if it.get("relevant") is not False][:8]
    if items:
        li = "\n".join(
            f'      <li><span class="cg-date">{hu_short_date(it["published"])}</span> '
            f'<a href="{esc(it["link"])}" target="_blank" rel="noopener">{esc(it["title"])}</a> '
            f'<span class="cg-kind">{esc(it["source"])}</span>'
            + (f'<span class="cg-sum">{esc(it["summary"])}</span>' if it.get("summary") else "") + "</li>"
            for it in items)
        note = ("Magyar hírportálok RSS-csatornáiból automatikusan gyűjtve, óránként ellenőrizve."
                + (" Az összefoglalókat mesterséges intelligencia készíti a cikkekből, hibázhat; "
                   "a pontos tartalomért nyisd meg a cikket." if any(it.get("summary") for it in items) else ""))
        parts += ['    <h2>Legfrissebb hírek</h2>', f'    <ul class="cg-list">\n{li}\n    </ul>',
                  f'    <p class="doc-note">{note}</p>']
    src = " · ".join(f'<a href="{esc(s["url"])}" target="_blank" rel="noopener">{esc(s["name"])}</a>'
                     for s in cg.get("sources", []))
    parts += ['    <h2>Források</h2>', f'    <p class="doc-note">{src}</p>',
              '    <p class="doc-more"><a href="/vizallas/tisza/">Tisza vízállás ma</a> · '
              '<a href="/vizallas/">Vízállás</a></p>']
    desc = ("Cigánd: 2008 óta először nyitották meg a tározó zsilipjeit, közel 2 milliárd liter Tisza-víz "
            "kerül a Bodrogközbe. Tények, időrend és friss hírek.")
    return [doc_page(ctx, path="/cigand/", title=f"Mi történt Cigándnál? A tározó zsilipnyitása | {SITE_NAME}",
                     description=desc, h1=cg["title"], body_html="\n".join(parts),
                     extra_scripts=f'  <script src="{CIGAND_PAGE_JS}"></script>\n')]


def build_about_page(ctx):
    """/az-oldalrol/: kapcsolat, adatforrások, adatvédelmi tájékoztató. Kézzel írt szöveg;
    a tartalma a script.js, a vizallas.js, a push-worker és a cigand_news.py tényleges működését írja le."""
    ext = lambda url, name: f'<a href="{url}" target="_blank" rel="noopener">{name}</a>'
    sources = [
        (ext("https://open-meteo.com/", "Open-Meteo"), "időjárás, csapadék és helykeresés (CC BY 4.0)"),
        (ext("https://www.bigdatacloud.com/", "BigDataCloud"), "a helynév a koordinátából"),
        (ext("https://www.rainviewer.com/", "RainViewer"), "radarkép"),
        (ext("https://odp.met.hu/", "Meteorológiai Adattár, HungaroMet Nonprofit Zrt."),
         "az éghajlati hőtérképek napi mérései 1901-től (átlagolva, simítva)"),
        (ext("https://www.hydroinfo.hu/", "hydroinfo.hu") + " (Országos Vízügyi Főigazgatóság)",
         "vízállás és előrejelzés"),
        (ext("https://wasser.bgld.gv.at/", "wasser.bgld.gv.at") + " (Burgenland)",
         "a Fertő vízállása 1965 és 2001 között"),
        ("10/1997. (V. 28.) KHVM rendelet", "a vízállás-oldalak készültségi szintjei"),
        (ext("https://www.openstreetmap.org/copyright", "OpenStreetMap") + " közreműködői (ODbL)",
         "folyók és tavak alakja a vízállás-térképen"),
        (ext("https://www.geoboundaries.org/", "geoBoundaries") + " (CC BY 4.0) és Natural Earth",
         "megye- és országhatárok"),
        (ext("https://www.deepseek.com/", "DeepSeek"),
         "a Cigánd-oldal hírösszefoglalói, mesterséges intelligenciával készülnek, hibázhatnak"),
    ]
    src_li = "\n".join(f"      <li>{a}: {b}</li>" for a, b in sources)
    mail_js = ("(function(){var e=document.getElementById('kapcsolat-mail');if(!e)return;"
               "var a=['info','holazeso','hu'],m=a[0]+String.fromCharCode(64)+a[1]+'.'+a[2],"
               "l=document.createElement('a');l.href='mailto:'+m;l.textContent=m;"
               "e.textContent='';e.appendChild(l);})();")
    body = f"""    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a></nav>
    <h1>Az oldalról</h1>
    <p class="vz-sentence">A hol az eső? egy magánszemély nem kereskedelmi hobbi- és tanulóprojektje.</p>
    <p>Megkeresi, hol esik a hozzád legközelebb, mutatja a folyók és tavak vízállását, és van egy külön oldala a cigándi tározó zsilipnyitásáról. Nincs mögötte cég, nincs hirdetés, és nem ad el semmit.</p>

    <h2>Adatforrások</h2>
    <ul class="cg-list">
{src_li}
    </ul>

    <h2>Kapcsolat</h2>
    <p>E-mail: <span id="kapcsolat-mail"><noscript>info kukac holazeso pont hu</noscript></span></p>
    <p>Hibát vagy ötletet a {ext("https://github.com/kovizozi/holazeso/issues", "GitHubon")} is bejelenthetsz. Az oldal forráskódja publikus: {ext("https://github.com/kovizozi/holazeso", "github.com/kovizozi/holazeso")}.</p>

    <h2>Adatvédelem</h2>
    <p>Az oldal nem kér regisztrációt, nem használ sütit, és nincs benne hirdetés.</p>
    <h3>Ami a böngésződben marad</h3>
    <p>Az utoljára használt helyed (név, koordináta, országkód), az utolsó legfeljebb 5 helyed, és hogy bekapcsoltad-e az értesítést. Ezeket a böngésző helyi tárolója (localStorage) őrzi, csak a te eszközödön van, a böngészőadatok törlésével eltűnik.</p>
    <h3>Amit a böngésződ közvetlenül más szolgáltatóknak küld</h3>
    <p>Kereséskor a böngésző a helyed koordinátáját (4 tizedesre kerekítve) az Open-Meteónak küldi a csapadékadatért, a pontos koordinátát a BigDataCloudnak a helynévért. Ha helyet gépelsz be, a beírt név az Open-Meteóhoz megy. A RainViewertől a radarkép csempéi töltődnek le a környékedről. Ezekhez az oldal nem közvetít: a kérés a böngésződből indul, így ezek a szolgáltatók látják az IP-címedet, és a saját szabályaik szerint kezelik.</p>
    <h3>Értesítés, ha esni kezd</h3>
    <p>Ha bekapcsolod, a szerverünkre (Cloudflare Worker és KV-tároló) kerül a böngésződ push-feliratkozása (a böngésző szolgáltatójának címe és titkosítási kulcsai), a mentett helyed pontos koordinátája és neve, valamint hogy éppen szárazat vagy esőt jeleztünk-e. Ebből percenként lekérjük az Open-Meteótól az ottani csapadékot, és ha elkezd esni, értesítést küldünk. Másra nem használjuk. A kikapcsoló gombbal a feliratkozás azonnal törlődik. Ha a böngésző érvénytelennek jelzi a feliratkozást, az értesítés küldési kísérletekor szintén törlődik. Más időkorlát nincs. Törlést e-mailben is kérhetsz.</p>
    <h3>Tárhely és látogatottság</h3>
    <p>Az oldalt a Cloudflare szolgáltatja (Cloudflare Pages), ezért a kérések adatait, például az IP-címet, a Cloudflare a tárhely működtetéséhez kezeli. A látogatottságot a GoatCounter (minden oldalon) és a Cloudflare Web Analytics (az esőkereső oldalakon) méri sütik nélkül, összesítve. Egyéni profilt nem építünk.</p>
    <h3>Kérdés, törlés</h3>
    <p>Ha kérdésed van, vagy törölni kérnéd az értesítési feliratkozásodat, írj az e-mail-címre.</p>
    <script>{mail_js}</script>"""
    return [doc_page(ctx, path="/az-oldalrol/",
                     title=f"Az oldalról: kapcsolat és adatvédelem | {SITE_NAME}",
                     description="Ki áll az oldal mögött, honnan jönnek az adatok, hogyan érhetsz el minket, és mit tárol az oldal rólad.",
                     h1="Az oldalról", body_html=body)]


# ---------------------------------------------------------------------------
# 3. fázis: /ho/ (hómód) és /widget/ (beágyazható doboz)

def build_snow_page(ctx):
    """/ho/: ugyanaz az alkalmazás, de a window.HOLAZESO_MODE = "ho" miatt a
    keresés csak a havazást tekinti találatnak (script.js SNOW_MODE)."""
    h1 = "Hol esik most a hó?"
    content = "\n".join([
        '  <section class="seo-content">',
        f'    <h2 class="seo-title">{esc(h1)}</h2>',
        '    <p class="about">',
        "      Ez az oldal megmondja, havazik-e most nálad, és ha nem, megkeresi, hol havazik",
        "      a hozzád legközelebb: a település nevét, a távolságot és az irányt is",
        "      megmutatja, radarképpel együtt. Ugyanaz a keresés, mint a",
        '      <a href="/">főoldalon</a>, de csak a hullő havat számítja találatnak.',
        "    </p>",
        '    <p class="about">',
        "      A pillanatnyi csapadékot és a hó mennyiségét az Open-Meteo, a radarképet a",
        "      RainViewer adja. Regisztráció és követés nélkül, bármelyik országban működik.",
        "    </p>",
        "  </section>",
    ])
    return [render_page(
        ctx, path="/ho/", title=f"Hol esik most a hó? | {SITE_NAME}",
        description=("Havazik most nálad? Élő csapadékadatból megkeressük, hol esik a hó "
                     "a hozzád legközelebb, radarképpel."),
        h1=h1, content_html=content, boot_script='window.HOLAZESO_MODE = "ho";',
        q1="Havazik most nálad?", slim_water=True)]


WIDGET_HTML = """<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Esik most? | hol az eső?</title>
<style>
:root { --fg: #000; --bg: #fff; --muted: #6b6b6b; --border: #d6d6d6; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --fg: #fff; --bg: #000; --muted: #9a9a9a; --border: #333; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 14px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); background: var(--bg);
  max-width: 320px; max-height: 120px; overflow: hidden;
  padding: 13px 13px 8px; border: 1px solid var(--border);
  display: flex; flex-direction: column; justify-content: space-between;
}
#q { margin: 0; font-size: 14px; color: var(--muted); }
#a { margin: 0; font-size: 38px; font-weight: 700; line-height: 1.05; }
#more { margin: 0; font-size: 12px; text-align: right; }
#more a { color: var(--muted); }
</style>
</head>
<body>
<p id="q">Esik most?</p>
<p id="a" aria-live="polite">&hellip;</p>
<p id="more"><a id="link" href="https://holazeso.hu/" target="_blank" rel="noopener">hol az eső?</a></p>
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var q = document.getElementById("q"), a = document.getElementById("a"), link = document.getElementById("link");
  function show(text) { a.textContent = text; }
  function check(lat, lon, loc) {
    q.textContent = "Esik most " + loc + "?";
    fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(4) + "&longitude=" + lon.toFixed(4) +
          "&current=precipitation,snowfall,weather_code")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var c = d.current;
        if (!c || typeof c.precipitation !== "number") throw new Error("nincs adat");
        var rate = c.precipitation * 3600 / (c.interval || 900);
        if ([56, 57, 66, 67].indexOf(c.weather_code) !== -1) show("Ónos eső");
        else if (c.snowfall > 0) show("Havazik");
        else show(rate >= 0.1 ? "Igen" : "Nem");
      })
      .catch(function () { show("?"); });
  }
  var lat = parseFloat(qs.get("lat")), lon = parseFloat(qs.get("lon"));
  var slug = qs.get("hely");
  if (slug && /^[a-z0-9-]+$/.test(slug)) {
    link.href = "https://holazeso.hu/eso/" + slug + "/";
    fetch("/places-hu.json").then(function (r) { return r.json(); }).then(function (list) {
      var p = list.filter(function (x) { return x.slug === slug; })[0];
      if (!p) throw new Error("ismeretlen hely");
      check(p.lat, p.lon, p.loc);
    }).catch(function () { q.textContent = "Ismeretlen hely"; show("?"); });
  } else if (isFinite(lat) && isFinite(lon)) {
    check(lat, lon, qs.get("name") ? qs.get("name") + " környékén" : "itt");
  } else {
    q.textContent = "Hiányzó hely"; show("?");
  }
})();
</script>
</body>
</html>
"""


def build_widget_page(ctx):
    return [Page("/widget/", WIDGET_HTML, indexable=False)]


# ---------------------------------------------------------------------------
# /eghajlat/: éghajlati hőtérképek 1901-től (adat: tools/import_climate_trends.py)

CLIMATE_FILE = ROOT / "data" / "eghajlat.json"
EGHAJLAT_JS = "/eghajlat.js?v=3"
EG_PRE = 12             # ennyi 5 napos sáv ráhagyás az előző év végéből (fent) és a következő év elejéből (lent)
EG_CW, EG_RH, EG_L, EG_T = 7, 5, 40, 4
EG_LEVELS = 6
EG_MONTHS = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.",
             "nov.", "dec."]
# id, cím, mit mutat (mondat), mértékegység, tizedesek, jelmagyarázat két vége, megfigyelés
EG_CHARTS = [
    ("szaraz", "Hosszabbodó száraz szakaszok",
     "Hány nap telt el átlagosan az utolsó, legalább 1 mm-es eső óta.", "nap", 1,
     ("rövidebb száraz szakaszok", "hosszabb száraz szakaszok"),
     "A század első felében rövidebbek voltak a csapadékmentes szakaszok. Az 1970-es évektől ősszel, "
     "az 1990-es évektől télen és tavasszal is hosszabbak: ritkábban esik."),
    ("heves", "Hevesebb esők",
     "Mennyi csapadék esik átlagosan egy esős (legalább 1 mm-es) napon.", "mm egy esős napon", 2,
     ("szelídebb esők", "hevesebb esők"),
     "Ha esik, egyre többet esik egyszerre, leginkább nyáron és ősszel. A kettő együtt: ritkább, de "
     "hevesebb esők, közöttük hosszabb szárazság."),
    ("homerseklet", "Melegedés",
     "A napi középhőmérséklet.", "°C", 1,
     ("hidegebb", "melegebb"),
     "Az 1980-as évekig nincs egyirányú változás, utána az egész év egyszerre melegszik, a legerősebben "
     "nyáron és a tél végén."),
    ("hoseg", "Több hőségnap",
     "A napok hány százalékán volt legalább 30 °C a napi maximum.", "% hőségnap", 1,
     ("kevesebb hőségnap", "több hőségnap"),
     "A 2000-es évektől júniustól szeptemberig sokkal gyakoribb a hőség, és a hőséges időszak hosszabb is lett."),
    ("tropusi", "Trópusi éjszakák",
     "A napok hány százalékán nem hűlt 20 °C alá a levegő éjszaka sem.", "% trópusi éjszaka", 1,
     ("kevesebb trópusi éjszaka", "több trópusi éjszaka"),
     "Az 1990-es évekig ritkaság volt, azóta július-augusztusban rendszeres, és már júniusban, szeptemberben is előfordul."),
    ("fagy", "Rövidülő fagyos időszak",
     "A napok hány százalékán ment 0 °C alá a minimum-hőmérséklet. A fekete vonalak az utolsó tavaszi "
     "és az első őszi fagy átlagos napját mutatják.", "% fagyos nap", 1,
     ("kevesebb fagyos nap", "több fagyos nap"),
     None),
]


def eg_num(x, digits):
    x = round(x, digits) + 0.0     # a "-0,0" elkerülésére
    s = f"{abs(x):.{digits}f}".replace(".", ",")
    return ("+" if x > 0 else "−" if x < 0 else "") + s


def eg_doy_text(doy):
    d = datetime.date(2001, 1, 1) + datetime.timedelta(days=round(doy))
    return f"{EG_MONTHS[d.month - 1]} {d.day}."


def eg_svg(cid, title, chart, ny, nb, frost=None):
    """A hőtérkép statikus SVG-je: oszloponként összevont, azonos szintű cellák (rect)."""
    anom, sc, k_div = chart["anom"], chart["scale"], chart["k"]
    rows = list(range(-EG_PRE, nb + EG_PRE))
    w = EG_L + EG_CW * ny + 4
    h = EG_T + EG_RH * len(rows) + 20

    def level(y, b):
        if b < 0:
            y, b = y - 1, b + nb
        elif b >= nb:
            y, b = y + 1, b - nb
        if not 0 <= y < ny:
            return None
        t = 0.5 + anom[b][y] / k_div / (2 * sc)
        return max(0, min(EG_LEVELS, math.floor(t * EG_LEVELS + 0.5)))   # mint a JS Math.round

    parts = []
    for y in range(ny):
        x = EG_L + y * EG_CW
        k = 0
        while k < len(rows):
            lv = level(y, rows[k])
            n = 1
            while k + n < len(rows) and level(y, rows[k + n]) == lv:
                n += 1
            if lv is not None:
                parts.append(f'<rect class="eg-l{lv}" x="{x}" y="{EG_T + k * EG_RH}" '
                             f'width="{EG_CW + 1}" height="{n * EG_RH + 0.5}"/>')
            k += n
    # hónapnevek a hónap közepénél; a ráhagyás-sávok neve halvány
    labels = []
    for k, b in enumerate(rows):
        bb = b % nb
        for m in range(12):
            mid = (datetime.date(2001, m + 1, 15) - datetime.date(2001, 1, 1)).days * nb / 365
            if int(mid) == bb:
                cls = ' class="eg-wrap"' if b < 0 or b >= nb else ""
                labels.append(f'<text{cls} x="{EG_L - 4}" y="{EG_T + k * EG_RH + 4}" '
                              f'text-anchor="end">{EG_MONTHS[m]}</text>')
    for edge in (0, nb):
        yy = EG_T + (edge + EG_PRE) * EG_RH
        labels.append(f'<line class="eg-yearline" x1="{EG_L}" x2="{EG_L + EG_CW * ny}" y1="{yy}" y2="{yy}"/>')
    y_axis = EG_T + len(rows) * EG_RH + 14
    for yr in range(1910, 1901 + ny, 10):
        labels.append(f'<text x="{EG_L + (yr - 1901) * EG_CW + EG_CW / 2}" y="{y_axis}" '
                      f'text-anchor="middle">{yr}</text>')
    lines = []
    if frost:
        for key in ("last", "first"):
            pts = " ".join(f"{EG_L + i * EG_CW + EG_CW / 2:.1f},"
                           f"{EG_T + (EG_PRE + d * nb / 365.25) * EG_RH:.1f}"
                           for i, d in enumerate(frost[key]))
            lines.append(f'<polyline class="eg-frost" points="{pts}"/>')
    return (f'<svg class="eg-svg" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" '
            f'data-pre="{EG_PRE}" data-cw="{EG_CW}" data-rh="{EG_RH}" data-l="{EG_L}" data-t="{EG_T}">'
            + '<g class="eg-cells">' + "".join(parts) + "</g>" + "".join(labels)
            + '<g class="eg-lines">' + "".join(lines) + "</g></svg>")


def eg_legend(chart, unit, digits, ends):
    sc = chart["scale"]
    sw = "".join(f'<span class="eg-sw eg-l{k}"></span>' for k in range(EG_LEVELS + 1))
    return (f'<p class="eg-legend"><span>{esc(ends[0])} (<span class="eg-lo">{eg_num(-sc, digits)}</span> {esc(unit)})</span>'
            f'<span class="eg-sws" aria-hidden="true">{sw}</span>'
            f'<span>{esc(ends[1])} (<span class="eg-hi">{eg_num(sc, digits)}</span> {esc(unit)})</span></p>')


# évenkénti összesítő táblázat: kulcs, megnevezés, mértékegység, tizedesek
EG_TABLE = [("t_ev", "Középhőmérséklet", "°C", 1), ("t_nyar", "Nyári középhőmérséklet (jún.-aug.)", "°C", 1),
            ("hoseg", "Hőségnap (legalább 30 °C)", "nap/év", 0), ("tropusi", "Trópusi éjszaka (legalább 20 °C)", "nap/év", 1),
            ("fagy", "Fagyos nap (minimum 0 °C alatt)", "nap/év", 0), ("csap", "Éves csapadék", "mm", 0),
            ("esonap", "Esős nap (legalább 1 mm)", "nap/év", 0), ("intenz", "Csapadék egy esős napon", "mm", 1),
            ("szaraz", "Napok az utolsó eső óta (átlag)", "nap", 1)]


def eg_slope(xs, ys):
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)


def eg_table(data):
    yr, y0, y1 = data["yearly"], data["y0"], data["y1"]
    rows = []
    for key, name, unit, d in EG_TABLE:
        v = yr[key]
        first, last = sum(v[:30]) / 30, sum(v[-30:]) / 30
        recent = list(range(1981, y1 + 1))
        dec = eg_slope(recent, v[1981 - y0:]) * 10
        fmt = lambda x: f"{x:.{d}f}".replace(".", ",")
        rows.append(f"        <tr><th scope=\"row\">{esc(name)}</th><td>{fmt(first)} {esc(unit)}</td>"
                    f"<td>{fmt(last)} {esc(unit)}</td><td>{eg_num(dec, max(d, 1))}</td></tr>")
    return (f'    <div class="eg-scroll eg-framed"><table class="eg-table">\n      <thead><tr><th scope="col">Jellemző</th>'
            f'<th scope="col">{y0}-{y0 + 29} átlaga</th><th scope="col">{y1 - 29}-{y1} átlaga</th>'
            f'<th scope="col">Változás évtizedenként 1981 óta</th></tr></thead>\n      <tbody>\n'
            + "\n".join(rows) + "\n      </tbody>\n    </table></div>")


def eg_scatter_section(data):
    import climate_charts
    cards = []
    for title, svg, summary, trust in climate_charts.build(data):
        cards.append(f"""      <figure class="eg-card">
        <h3 class="eg-card-title">{esc(title)}</h3>
        {svg}
        <p class="eg-card-sum">{esc(summary[0].upper() + summary[1:])}.</p>
        <p class="eg-card-note">{esc(trust)}</p>
        <div class="vz-tip" hidden></div>
      </figure>""")
    sw = "".join(f'<span class="eg-sw eg-y{k}"></span>' for k in range(0, 13, 2))
    return f"""    <h2 id="kitekintes">Összefüggések és kitekintés</h2>
    <p>Évenként egy pont, a szín az évet mutatja. A hőségnapok és a trópusi éjszakák szorosan követik a nyári hőmérsékletet, ezért ott forgatókönyvet adunk: mire számíthatunk egy 1 vagy 2 °C-kal melegebb nyáron. A csapadéknál ilyen kapcsolat nincs, ott csak a hosszú távú irányt lehet óvatosan meghosszabbítani.</p>
    <p class="eg-legend"><span>1901</span><span class="eg-sws" aria-hidden="true">{sw}</span><span>2025</span><span>· fekete vonal: modell vagy simított átlag · kék sáv: az évek 90%-a ebbe esik</span></p>
    <div class="eg-sc-grid">
{chr(10).join(cards)}
    </div>"""


def build_climate_page(ctx):
    if not CLIMATE_FILE.exists():
        return []
    text = CLIMATE_FILE.read_text(encoding="utf-8")
    data = json.loads(text)
    h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    y0, y1, nb = data["y0"], data["y1"], data["nb"]
    ny = y1 - y0 + 1
    lv = data["default"]
    fr = data["frost"][lv]
    fr0 = data["frost"]["eros"]     # a szöveges összefoglaló mindig az erős simításból (stabilabb)
    frost_note = (f"Az utolsó tavaszi fagy a század elején átlagosan {eg_doy_text(fr0['last'][5])}, napjainkban "
                  f"{eg_doy_text(fr0['last'][-6])} körül volt, az első őszi fagy {eg_doy_text(fr0['first'][5])} "
                  f"helyett {eg_doy_text(fr0['first'][-6])} körül jön: a fagymentes időszak "
                  f"kb. {round((fr0['first'][-6] - fr0['last'][-6]) - (fr0['first'][5] - fr0['last'][5]))} nappal hosszabb. "
                  "A fagyos napok száma a 2000-es évektől télen is látványosan csökkent.")
    seg = "".join(f'<button type="button" data-level="{k}" aria-pressed="{str(k == lv).lower()}">{t}</button>'
                  for k, t in (("enyhe", "enyhe simítás"), ("kozepes", "közepes"), ("eros", "erős")))
    figs = []
    for cid, title, what, unit, digits, ends, note in EG_CHARTS:
        chart = data["charts"][cid][lv]
        note = note or frost_note
        svg = eg_svg(cid, title, chart, ny, nb, fr if cid == "fagy" else None)
        figs.append(f"""    <h2 id="{cid}">{esc(title)}</h2>
    <p>{esc(note)}</p>
    <figure class="vz-fig eg-fig" data-eg="{cid}" data-unit="{esc(unit)}" data-digits="{digits}" data-src="/data/eghajlat.json?h={h}">
      <div class="vz-bar"><h3 class="vz-title">{esc(title)}, {y0}-{y1}</h3></div>
      <p class="eg-what">{esc(what)} Az adott időszak szokásos értékéhez képest.</p>
      <div class="vz-ctl eg-ctl" hidden><div class="vz-seg" role="group" aria-label="Simítás">{seg}</div></div>
      <div class="eg-scroll">{svg}</div>
      {eg_legend(chart, unit, digits, ends)}
      <div class="vz-tip" hidden></div>
    </figure>""")
    toc = " · ".join(f'<a href="#{cid}">{esc(t)}</a>' for cid, t, *_ in EG_CHARTS) + ' · <a href="#szamokban">Számokban</a> · <a href="#kitekintes">Összefüggések és kitekintés</a>'
    stations = "Budapest, Debrecen, Keszthely, Miskolc, Nyíregyháza, Pécs, Sopron, Szeged, Szombathely, Túrkeve"
    body = f"""    <div class="eg-page">
    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a></nav>
    <h1>Így változott Magyarország időjárása {y0} óta</h1>
    <p class="vz-sentence">Az éves csapadék alig változott, de ritkábban és hevesebben esik, közte hosszabb a szárazság, és egyre melegebb van.</p>
    <p>Minden ábrán vízszintesen az évek ({y0}-{y1}), függőlegesen az év napjai láthatók, 5 napos sávokban. A szaggatott vonalak között van az adott év, fölötte az előző év vége, alatta a következő év eleje, így a december-január fordulón átnyúló időszakok is egyben látszanak. A szín azt mutatja, hogy az adott időszak mennyire tért el a 125 éves átlagtól: sötétebb kék = több abból, amiről az ábra szól.</p>
    <p class="doc-note">Az évről évre ingadozó időjárásból a hosszú távú változás csak simítva látszik: minden cella a környező napok és évek súlyozott átlaga. A simítás erőssége ábránként állítható: enyhe (kb. ±15 nap és ±4 év, több részlet, több zaj), közepes (±20 nap, ±8 év) vagy erős (±30 nap, ±12 év, csak a hosszú távú irány). Erősebb simításnál egy-egy kiugró év (például egy aszályos nyár) nem látszik külön, és a két szélén, az első és utolsó években kevesebb év jut egy cellára, ott a kép bizonytalanabb. Ugorj az ábrákra: {toc}</p>
{chr(10).join(figs)}
    <h2 id="szamokban">Számokban</h2>
    <p>Évenkénti értékek a 10 állomás átlagaként: az első és az utolsó 30 év átlaga, és a változás üteme 1981 óta (lineáris trend, évtizedenként).</p>
{eg_table(data)}
    <p class="doc-note">A hőmérséklet és a belőle következő jellemzők (hőség, trópusi éjszaka, fagy) egyértelműen és gyorsulva változnak. Az éves csapadék alig, viszont kevesebb napon esik, és egy esős napon több: ezért hosszabbak a száraz szakaszok.</p>
{eg_scatter_section(data)}
    <h2>Az adatokról</h2>
    <p>Napi mérések 10 állomásról ({stations}), {y0}-től {y1}-ig, a HungaroMet homogenizált adatsoraiból (a homogenizálás kiszűri az állomásáthelyezések és műszercserék okozta ugrásokat). Az ábrák a 10 állomás átlagát mutatják.</p>
    <p class="doc-note">Adatbázis: <a href="https://odp.met.hu/" target="_blank" rel="noopener">Meteorológiai Adattár, HungaroMet Nonprofit Zrt.</a>, átlagolva, simítva és grafikusan reprodukálva.</p>
    </div>"""
    return [doc_page(ctx, path="/eghajlat/",
                     title=f"Így változott Magyarország időjárása 1901 óta | {SITE_NAME}",
                     description="Hőtérképek 125 év napi méréseiből: hosszabb száraz szakaszok, hevesebb esők, melegedés, több hőségnap és trópusi éjszaka, rövidebb fagyos időszak.",
                     h1="Így változott Magyarország időjárása", body_html=body,
                     extra_scripts=f'  <script src="{EGHAJLAT_JS}" defer></script>\n')]


PAGE_BUILDERS = [build_home, build_town_pages, build_cigand_page, build_about_page, build_water_pages,
                 build_snow_page, build_widget_page, build_climate_page]


# ---------------------------------------------------------------------------
# Kimenet

def read_old_sitemap():
    """url -> (lastmod, hash) a meglévő sitemap.xml-ből."""
    f = ROOT / "sitemap.xml"
    if not f.exists():
        return {}
    pat = re.compile(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>\s*<!--h:([0-9a-f]+)-->")
    return {m.group(1): (m.group(2), m.group(3)) for m in pat.finditer(f.read_text(encoding="utf-8"))}


def write_if_changed(f, text):
    if f.exists() and f.read_text(encoding="utf-8") == text:
        return False
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text, encoding="utf-8")
    return True


def write_sitemap(pages, today, water_ok=True):
    old = read_old_sitemap()
    entries = []
    for pg in pages:
        if not pg.indexable:
            continue
        url = BASE_URL + pg.path
        h = hashlib.sha256(pg.html.encode("utf-8")).hexdigest()[:12]
        lastmod = old[url][0] if url in old and old[url][1] == h else today
        entries.append(f"  <url>\n    <loc>{url}</loc>\n    <lastmod>{lastmod}</lastmod>\n"
                       f"    <!--h:{h}-->\n  </url>")
    if not water_ok:
        # Nincs friss vízadat: a meglévő vízoldalak (és sitemap-bejegyzésük) maradnak.
        have = {BASE_URL + pg.path for pg in pages}
        for url, (lm, h) in old.items():
            if "/vizallas/" in url and url not in have:
                entries.append(f"  <url>\n    <loc>{url}</loc>\n    <lastmod>{lm}</lastmod>\n"
                               f"    <!--h:{h}-->\n  </url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + "\n".join(entries) + "\n</urlset>\n")
    write_if_changed(ROOT / "sitemap.xml", xml)


def remove_stale(pages):
    """Az eso/ alatt csak generált oldal lehet: ami már nem generálódik, törlődik."""
    keep = {page_file(pg.path) for pg in pages}
    for f in (ROOT / "eso").glob("*/index.html"):
        if f not in keep:
            f.unlink()
            try:
                f.parent.rmdir()
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch-climate", action="store_true",
                    help="a hiányzó klíma-bejegyzések lekérése az Open-Meteo archive API-ból")
    ap.add_argument("--climate-limit", type=int, default=None,
                    help="legfeljebb ennyi hely lekérése (helyi teszthez)")
    ap.add_argument("--fetch-water", action="store_true",
                    help="a vízállás-pillanatképek lekérése a workertől (Action)")
    ap.add_argument("--fetch-recent", action="store_true",
                    help="friss csapadék a településekhez az Open-Meteo forecast API-ból (Action)")
    ap.add_argument("--recent-limit", type=int, default=None,
                    help="legfeljebb ennyi hely lekérése (helyi teszthez)")
    ap.add_argument("--fetch-history", action="store_true",
                    help="a folyó év vízállás-táblái a hydroinfo.hu-ról a water-history.json-ba (Action)")
    ap.add_argument("--water-dir", default=None,
                    help="teszt: rivers.json és lakes.json ebből a mappából")
    args = ap.parse_args()

    if args.fetch_history:
        import hydro_history
        hydro_history.refresh_current()

    # A sablon az index.html: a generált lista régi tartalma nem számít, mert
    # minden builder a jelölők közti részt írja felül.
    template = (ROOT / "index.html").read_text(encoding="utf-8")
    places = load_places()
    climate = load_climate()
    if args.fetch_climate:
        fetch_missing_climate(places, climate, args.climate_limit)
    recent = load_recent()
    if args.fetch_recent:
        fetch_recent(places, recent, args.recent_limit)
    water = load_water(args)
    if water:
        update_recent_water(places, recent, water)
    ctx = Ctx(template, places, climate, datetime.date.today().isoformat(), water=water,
              recent=recent)

    pages = []
    for builder in PAGE_BUILDERS:
        pages.extend(builder(ctx))
    paths = [pg.path for pg in pages]
    assert len(paths) == len(set(paths)), "ismétlődő útvonal"

    changed = 0
    for pg in pages:
        if write_if_changed(page_file(pg.path), pg.html):
            changed += 1
    for rel, text in ctx.files.items():
        if write_if_changed(ROOT / rel, text):
            changed += 1
    remove_stale(pages)
    write_sitemap(pages, ctx.today, water_ok=ctx.water is not None)
    print(f"{len(pages)} oldal, ebből {changed} változott", file=sys.stderr)


if __name__ == "__main__":
    main()
