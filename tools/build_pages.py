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
  python3 tools/build_pages.py --water-dir DIR        # teszt: DIR/rivers.json + lakes.json

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
    extra: dict = field(default_factory=dict)


def page_file(path):
    """URL-útvonalból fájl a repóban."""
    return ROOT / "index.html" if path == "/" else ROOT / path.strip("/") / "index.html"


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


def render_page(ctx, *, path, title, description, h1, content_html,
                boot_script="", indexable=True):
    """Egy aloldal a sablonból. content_html a teljes h1-et és bevezetőt is
    tartalmazza (a h1 paraméter a JSON-LD nevéhez kell)."""
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
    """A főoldal maga a sablon, csak a településlista generált."""
    alpha = sorted(ctx.places, key=lambda p: p["n"].casefold().translate(HU_SORT))
    html = replace_between(ctx.template, "places", places_nav(alpha))
    return [Page("/", html)]


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
        content = [
            '  <section class="seo-content">',
            f"    <h1>{esc(h1)}</h1>",
            '    <p class="about">',
            f"      Ez az oldal élő adatból megmondja, esik-e most {esc(loc)}, és ha nem,",
            "      megkeresi, hol esik a legközelebb: a település nevét, a távolságot,",
            "      az irányt és az eső erősségét is megmutatja, radarképpel együtt.",
            "      A <a href=\"/\">főoldalon</a> a saját helyedre is megnézheted.",
            "    </p>",
        ]
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
            content_html="\n".join(content), boot_script=boot))
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
               "Agárd": "Agárdnál", "Fertőrákos": "Fertőrákosnál"}
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


def sparkline(st):
    """Statikus SVG a history utolsó ~8 napjából; színt a CSS ad (.spark-*)."""
    hist = st.get("history") or []
    if len(hist) < 3:
        return ""
    step = max(1, len(hist) // 64)
    pts = [h["level_cm"] for h in hist[::step]] + [hist[-1]["level_cm"]]
    lo, hi = min(pts), max(pts)
    w, h, pad = 320, 64, 6
    span = (hi - lo) or 1
    xy = [(pad + (w - 2 * pad) * i / (len(pts) - 1), h - pad - (h - 2 * pad) * (v - lo) / span)
          for i, v in enumerate(pts)]
    d = " ".join(f"{'M' if i == 0 else 'L'}{x:.1f} {y:.1f}" for i, (x, y) in enumerate(xy))
    first, last = parse_ts(hist[0]["at"]), parse_ts(hist[-1]["at"])
    days = max(1, round((last - first).total_seconds() / 86400))
    label = (f"{st['name']} vízállása az elmúlt {days} napban: legalacsonyabb "
             f"{cm_text(lo)}, legmagasabb {cm_text(hi)}, most {cm_text(st['level_cm'])}")
    return (f'<figure class="spark-fig"><svg class="spark" viewBox="0 0 {w} {h}" role="img" '
            f'aria-label="{esc(label)}"><path class="spark-line" d="{d}"/>'
            f'<circle class="spark-dot" cx="{xy[-1][0]:.1f}" cy="{xy[-1][1]:.1f}" r="3"/></svg>'
            f'<figcaption>Elmúlt {days} nap: legalacsonyabb {cm_short(lo)}, legmagasabb {cm_short(hi)}.'
            f'</figcaption></figure>')


def doc_page(ctx, *, path, title, description, h1, body_html, extra_scripts=""):
    """Könnyű szöveges oldal: a sablon feje (meta, style.css), saját törzs.
    extra_scripts: a GoatCounter elé kerülő saját script-címkék."""
    page = render_page(ctx, path=path, title=title, description=description, h1=h1,
                       content_html="")
    head = page.html[:page.html.index("<body>")]
    html = (head + '<body class="doc">\n'
            '  <header class="doc-top"><a class="doc-home" href="/">hol az eső?</a>\n'
            '    <nav aria-label="Oldalak"><a href="/vizallas/">Vízállás</a> '
            '<a href="/cigand/">Cigánd</a></nav></header>\n'
            '  <main class="doc-main">\n' + body_html + '\n  </main>\n'
            '  <footer>\n    <p class="credits">holazeso.hu · <a href="/">Hol esik most?</a> · '
            'Vízállás: <a href="https://www.hydroinfo.hu/" target="_blank" rel="noopener">hydroinfo.hu</a> '
            '(Országos Vízügyi Főigazgatóság)</p>\n  </footer>\n'
            + extra_scripts +
            '  <script data-goatcounter="https://holazeso.goatcounter.com/count"\n'
            '          async src="//gc.zgo.at/count.js"></script>\n</body>\n</html>\n')
    return Page(path, html)


def water_stations(snapshot, names, key):
    by = {}
    for st in snapshot["stations"]:
        nm = st["name"] if key == "river" else st["station"]
        if nm in EXCLUDE or st.get("stale") or not isinstance(st.get("level_cm"), (int, float)):
            continue
        by.setdefault(st[key], {})[nm] = st
    return by


def build_water_pages(ctx):
    if not ctx.water:
        return []
    rivers, lakes = ctx.water
    gen = parse_ts(rivers["generated_at"])
    date = hu_date(gen)
    river_by = water_stations(rivers, None, "river")
    lake_by = water_stations(lakes, None, "lake")
    src_p = (f'<p class="doc-note">Forrás: <a href="https://www.hydroinfo.hu/" target="_blank" '
             f'rel="noopener">hydroinfo.hu</a>, Országos Vízügyi Főigazgatóság. Állás: {date} '
             f'A holazeso.hu adatgyűjtője óránként tölti le; a vízállás az adott mérce saját '
             f'0 pontjához mért centiméter, nem tengerszint feletti magasság.</p>')
    pages, overview_rows = [], []
    nav_links = " · ".join(f'<a href="/vizallas/{sl}/">{esc(nm)}</a>'
                           for sl, nm, _ in RIVER_PAGES + LAKE_PAGES)

    def build(kind, sl, name, order):
        group = (river_by if kind == "river" else lake_by).get(name, {})
        stations = [group[n] for n in order if n in group]
        if kind == "lake":
            stations += [st for n, st in group.items() if n not in order and n != "Balaton average"]
        if not stations:
            return
        parts, titles, desc_bits, sections = [], [], [], []
        for st in stations:
            nm = st["name"] if kind == "river" else st["station"]
            lv = st["level_cm"]
            delta = week_change(st) if kind == "river" else None
            loc = STATION_LOC.get(nm, nm)
            sentence = f"A {name} vízállása {loc} ma {cm_text(lv)}{change_phrase(delta)}."
            sec = [f'    <section class="vz-station">\n      <h2>{esc(STATION_LABEL.get(nm, nm))}</h2>',
                   f'      <p class="vz-sentence">{esc(sentence)}</p>']
            spark = sparkline(st) if kind == "river" else ""
            if spark:
                sec.append("      " + spark)
            sec.append("    </section>")
            sections.append("\n".join(sec))
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
                + ("Változás egy hét alatt, grafikon, forrás: hydroinfo.hu." if kind == "river"
                   else "Forrás: hydroinfo.hu, mérési dátummal."))
        h1 = f"{name} vízállás ma"
        body = (f'    <nav class="doc-crumb" aria-label="Morzsa"><a href="/">hol az eső?</a> / '
                f'<a href="/vizallas/">Vízállás</a></nav>\n    <h1>{esc(h1)}</h1>\n'
                + "\n".join(sections) + "\n    " + src_p
                + f'\n    <p class="doc-more">Más folyók és tavak: {nav_links}.</p>')
        pages.append(doc_page(ctx, path=f"/vizallas/{sl}/", title=title, description=desc,
                              h1=h1, body_html=body))

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
            f' Az alábbi táblázatban a magyarországi folyók és nagy tavak mérőállomásai, a folyóknál az egy hete mért '
            f'értékhez képest.</p>\n'
            f'    <table class="vz-table">\n      <thead><tr><th scope="col">Víz, mérőállomás</th>'
            f'<th scope="col">Vízállás</th><th scope="col">7 nap alatt (cm)</th></tr></thead>\n'
            f'      <tbody>\n' + "\n".join(rows) + '\n      </tbody>\n    </table>\n    ' + src_p
            + f'\n    <p class="doc-more">Részletek: {nav_links}. '
              f'<a href="/cigand/">Mi történt Cigándnál?</a></p>')
    pages.insert(0, doc_page(
        ctx, path="/vizallas/", title=f"Vízállás ma: Duna, Tisza, Balaton | {SITE_NAME}",
        description=("Magyar folyók és tavak vízállása ma: Duna, Tisza, Rába, Maros, Körös, Dráva, "
                     "Balaton, Velencei-tó, Fertő. Változás egy hét alatt, forrás: hydroinfo.hu."),
        h1=h1, body_html=body))
    return pages


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
CIGAND_PAGE_JS = "/cigand-page.js?v=1"


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
        f'      <dt>{esc(q["q"])}</dt>\n      <dd>{esc(q["a"])}{ex(q.get("source"))}{kind(q.get("kind"))}</dd>'
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


# ---------------------------------------------------------------------------
# 3. fázis: /ho/ (hómód) és /widget/ (beágyazható doboz)

def build_snow_page(ctx):
    """/ho/: ugyanaz az alkalmazás, de a window.HOLAZESO_MODE = "ho" miatt a
    keresés csak a havazást tekinti találatnak (script.js SNOW_MODE)."""
    h1 = "Hol esik most a hó?"
    content = "\n".join([
        '  <section class="seo-content">',
        f"    <h1>{esc(h1)}</h1>",
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
        h1=h1, content_html=content, boot_script='window.HOLAZESO_MODE = "ho";')]


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


PAGE_BUILDERS = [build_home, build_town_pages, build_cigand_page, build_water_pages,
                 build_snow_page, build_widget_page]


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
    ap.add_argument("--water-dir", default=None,
                    help="teszt: rivers.json és lakes.json ebből a mappából")
    args = ap.parse_args()

    # A sablon az index.html: a generált lista régi tartalma nem számít, mert
    # minden builder a jelölők közti részt írja felül.
    template = (ROOT / "index.html").read_text(encoding="utf-8")
    places = load_places()
    climate = load_climate()
    if args.fetch_climate:
        fetch_missing_climate(places, climate, args.climate_limit)
    ctx = Ctx(template, places, climate, datetime.date.today().isoformat(), water=load_water(args))

    pages = []
    for builder in PAGE_BUILDERS:
        pages.extend(builder(ctx))
    paths = [pg.path for pg in pages]
    assert len(paths) == len(set(paths)), "ismétlődő útvonal"

    changed = 0
    for pg in pages:
        if write_if_changed(page_file(pg.path), pg.html):
            changed += 1
    remove_stale(pages)
    write_sitemap(pages, ctx.today, water_ok=ctx.water is not None)
    print(f"{len(pages)} oldal, ebből {changed} változott", file=sys.stderr)


if __name__ == "__main__":
    main()
