"""Közös rész a vízállás-idősorhoz (water-history.json): HTTP, éves összegzés, az újabb
hydroinfo táblák (tb) és a burgenlandi tószint-adatok olvasása, valamint a napi frissítés
(`refresh_current`, a build_pages.py --fetch-history hívja). Csak stdlib.

Forrás-jelölők (az évek `src` mezője):
  hydroinfo-archive   régi éves archívum (tools/import_hydro_archive.py)
  hydroinfo-tb        újabb éves táblák (lezárt évek)
  hydroinfo-current   az aktuális év táblája (partial: true, through: utolsó nap)
  balaton-avg         a Balaton átlagos vízállása (Siófok-adat híján, 2021-től)
  bgld                burgenlandi (osztrák) tószint, cm-re átszámítva (Fertő, 1965-2001)

Napi sor (`daily`, állomásonként): az utolsó DAILY_DAYS nap reggeli (7 órás) értékei,
{"start": "ÉÉÉÉ-HH-NN", "cm": [...]} (null = hiányzó nap). Ebből rajzol a /vizallas/ grafikon
(30 nap, 1 év). A Siófoknak nincs napi táblája: a Balaton átlag ("ba") sorát használja az oldal.
"""
import datetime
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

UA = "holazeso.hu-archive-import"
OUT = Path(__file__).resolve().parent.parent / "water-history.json"
SOURCE_TEXT = ("hydroinfo.hu, Központi Hidrológiai Adattár (OVF), napi reggeli (7 órás) vízállások "
               "alapján számolt éves minimum, maximum és átlag (cm)")
TB_PAST = "https://www.hydroinfo.hu/Html/archivum/tb{year}/tb{code}.htm"
TB_CURRENT = "https://www.hydroinfo.hu/Html/hidinfo/AktualisEvesTb/tb{code}.htm"
BGLD = "https://wasser.bgld.gv.at/export/hjpRalsA7imnA-XjIsk6qQ/1d/{year}"
BGLD_ZERO_M = 114.975          # Fertő-szint (m Adria), amit a Fertőrákos-mérce nullájának veszünk
# állomás-kód -> újabb tábla kódja (Siófoknak nincs; a 2021 utáni Balaton-szakasz a ba kódból jön)
TB_CODE = {"bp": "442027", "nm": "442527", "mo": "442032", "so": "444229", "se": "444231",
           "vn": "444227", "ag": "442558", "ba": "442600", "fe": "442613",
           "nb": "442502", "tb": "444226", "ka": "444537", "sz": "444569"}
# nincs régi (1876-) archívumuk: az újabb táblák 2002-től (a Fertő előtte a burgenlandi adat)
TB_ONLY = {"fe", "nb", "tb", "ka", "sz"}
STATIONS = {
    "si": ("Siófok", "Balaton"), "ba": ("Balaton átlag", "Balaton"),
    "ag": ("Agárd", "Velencei-tó"), "bp": ("Budapest", "Duna"),
    "nm": ("Nagymaros", "Duna"), "mo": ("Mohács", "Duna"),
    "so": ("Szolnok", "Tisza"), "se": ("Szeged", "Tisza"),
    "vn": ("Vásárosnamény", "Tisza"), "fe": ("Fertőrákos", "Fertő"),
    "nb": ("Nagybajcs", "Duna"), "tb": ("Tiszabecs", "Tisza"),
    "ka": ("Kisköre alsó", "Tisza"), "sz": ("Szarvas", "Hármas-Körös"),
}
MAX_ABS_CM = 2000   # ennél nagyobb abszolút érték hibajelző (pl. a Szeged 1972-es 30002), kihagyjuk
DAILY_DAYS = 400    # a napi sor hossza (egy év + tartalék a grafikon 1 éves nézetéhez)
LAST_FETCH = [0.0]


def get(url, cache_file=None, offline=False):
    """A válasz bájtjai (vagy None, ha nincs ilyen oldal). 1 kérés/mp, újrapróbálkozással;
    cache_file megadva: lemezes gyorsítótár (.missing jelzi a 404-et)."""
    if cache_file is not None:
        miss = cache_file.with_name(cache_file.name + ".missing")
        if cache_file.exists():
            return cache_file.read_bytes()
        if miss.exists() or offline:
            return None
    for attempt in range(5):
        wait = 1.0 - (time.time() - LAST_FETCH[0])
        if wait > 0:
            time.sleep(wait)
        LAST_FETCH[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
            if cache_file is not None:
                cache_file.write_bytes(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                if cache_file is not None:
                    miss.write_text("404")
                return None
            time.sleep(3 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(3 * (attempt + 1))
    return None


def summarize(year, grid, src, today=None, shift=0, zero_m=None):
    """grid: {(hónap, nap): cm}. Az aktuális évnél partial + through. shift: a mérce régi
    nullpontjáról a mostanira átszámolás (cm), minden napi értékre a min/max/átlag előtt."""
    vals = sorted((k, v + shift) for k, v in grid.items())
    if not vals:
        return None
    lo = min(v for _, v in vals)
    hi = max(v for _, v in vals)
    dlo = next(k for k, v in vals if v == lo)
    dhi = next(k for k, v in vals if v == hi)
    iso = lambda k: f"{year}-{k[0]:02d}-{k[1]:02d}"
    s = {"min": lo, "min_date": iso(dlo), "max": hi, "max_date": iso(dhi),
         "mean": round(sum(v for _, v in vals) / len(vals), 1), "n": len(vals), "src": src}
    if shift:
        s["shift_cm"] = shift
        s["zero_m"] = zero_m
    if today is not None and year == today.year:
        s["partial"] = True
        s["through"] = iso(vals[-1][0])
    return s


def parse_tb(data):
    """(év, {(hónap, nap): cm}) egy újabb éves táblából (latin2 vagy UTF-8, <pre> rács;
    üres vagy "..." = hiányzó). A hónap-oszlop vége a JAN indexe + 3, hónaponként +6."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("iso-8859-2", "replace")
    text = re.sub(r"<[^>]*>", "", text)
    lines = text.splitlines()
    hi = next((i for i, ln in enumerate(lines) if "NAP" in ln and "JAN" in ln), None)
    if hi is None:
        return None, {}
    years = re.findall(r"\b(20\d\d)\b", "\n".join(lines[:hi]))
    if not years:
        return None, {}
    year = int(years[-1])
    e0 = lines[hi].index("JAN") + 3
    grid = {}
    for ln in lines[hi + 1:]:
        m = re.match(r"^\s{0,3}(\d{1,2})\s{2,}", ln)
        if not m or not 1 <= int(m.group(1)) <= 31:
            continue
        day = int(m.group(1))
        for mo in range(12):
            c = ln[e0 + mo * 6 - 6:e0 + mo * 6].strip()
            if re.fullmatch(r"-?\d+", c) and abs(int(c)) < MAX_ABS_CM:
                try:
                    datetime.date(year, mo + 1, day)
                except ValueError:
                    continue
                grid[(mo + 1, day)] = int(c)
    return year, grid


def parse_bgld(data, year):
    """{(hónap, nap): cm} a burgenlandi napi középértékekből (m Adria -> cm a Fertő-nullához)."""
    grid = {}
    for ln in data.decode("utf-8", "replace").splitlines():
        m = re.match(r"^(\d{4})-(\d\d)-(\d\d)\s+(-?\d+(?:\.\d+)?)\s*$", ln)
        if m and int(m.group(1)) == year:
            grid[(int(m.group(2)), int(m.group(3)))] = round((float(m.group(4)) - BGLD_ZERO_M) * 100)
    return grid


def load(path=OUT):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def dumps(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def save(data, path=OUT):
    data["source"] = SOURCE_TEXT
    data["stations"] = dict(sorted(data.get("stations", {}).items()))
    new = dumps(data)
    p = Path(path)
    if not p.exists() or p.read_text("utf-8") != new:
        p.write_text(new, "utf-8")
        return True
    return False


def station(data, code):
    st = data.setdefault("stations", {}).setdefault(code, {})
    name, water = STATIONS[code]
    st.setdefault("name", name)
    st.setdefault("water", water)
    st.setdefault("unit", "cm")
    st.setdefault("years", {})
    st.setdefault("zero_changes", [])
    return st


def fetch_grid(code, year, today, cache=None, offline=False):
    """(grid, src): egy év napi rácsa az újabb táblából (a folyó év a "current" oldalról,
    gyorsítótár nélkül), vagy (None, None)."""
    if year == today.year:
        data = get(TB_CURRENT.format(code=TB_CODE[code]), None, offline)
        src = "hydroinfo-current"
    else:
        cf = cache / f"tb{year}-{TB_CODE[code]}.htm" if cache else None
        data = get(TB_PAST.format(year=year, code=TB_CODE[code]), cf, offline)
        src = "hydroinfo-tb"
    if not data:
        return None, None
    y, grid = parse_tb(data)
    if y != year or not grid:
        return None, None
    return grid, src


def fetch_year_tb(code, year, today, cache=None, offline=False):
    """Egy év összegzése az újabb táblából."""
    grid, src = fetch_grid(code, year, today, cache, offline)
    return summarize(year, grid, src, today) if grid else None


def merge_daily(old, grids, today):
    """A napi sor összefésülése: old a tárolt {"start", "cm"}, grids: {év: {(hó, nap): cm}}
    (az újabb érték felülír). Az ablak az utolsó DAILY_DAYS nap, az utolsó ismert napig."""
    vals = {}
    if old and old.get("start"):
        d0 = datetime.date.fromisoformat(old["start"])
        for i, v in enumerate(old["cm"]):
            if v is not None:
                vals[d0 + datetime.timedelta(days=i)] = v
    for year, grid in grids.items():
        for (mo, day), v in grid.items():
            try:
                vals[datetime.date(year, mo, day)] = v
            except ValueError:
                pass
    lo = today - datetime.timedelta(days=DAILY_DAYS - 1)
    vals = {d: v for d, v in vals.items() if lo <= d <= today}
    if not vals:
        return old
    first, last = min(vals), max(vals)
    n = (last - first).days + 1
    return {"start": first.isoformat(),
            "cm": [vals.get(first + datetime.timedelta(days=i)) for i in range(n)]}


def link_balaton(data):
    """Siófok 2021-től (az archívum vége után): a Balaton átlag azonos évei, "balaton-avg" jelölővel."""
    si, ba = data.get("stations", {}).get("si"), data.get("stations", {}).get("ba")
    if not si or not ba:
        return
    last = max((int(y) for y, v in si["years"].items() if v.get("src") != "balaton-avg"), default=None)
    for y in [y for y, v in si["years"].items() if v.get("src") == "balaton-avg"]:
        del si["years"][y]
    for y, v in ba["years"].items():
        if last and int(y) > last:
            si["years"][y] = dict(v, src="balaton-avg")
    si["years"] = dict(sorted(si["years"].items()))


def refresh_current(today=None, path=OUT, cache=None):
    """Napi frissítés: csak a folyó év táblái (9 GET), januárban az előző év is; a napi sorhoz
    (DAILY_DAYS nap) az előző évi tábla is kell, ha a tárolt sor még nem éri el az ablak elejét
    (egyszer, aztán a gyorsítótárba/sorba kerül). Hálózati hiba esetén a meglévő adat marad.
    True, ha a fájl változott."""
    today = today or datetime.date.today()
    data = load(path)
    if not data.get("stations"):
        print("history: nincs water-history.json, előbb tools/import_hydro_archive.py")
        return False
    years = [today.year] + ([today.year - 1] if today.month == 1 else [])
    win_start = today - datetime.timedelta(days=DAILY_DAYS - 1)
    for code in TB_CODE:
        if code not in data["stations"]:
            continue
        st = data["stations"][code]
        grids = {}
        for y in sorted(set(years) | set(range(win_start.year, today.year + 1))):
            have = st.get("daily")
            if y != today.year and y not in years and have and have["start"] <= win_start.isoformat():
                continue            # a régebbi évet már beolvastuk a sorba
            grid, src = fetch_grid(code, y, today, cache)
            if not grid:
                continue
            grids[y] = grid
            if y in years:
                st["years"][str(y)] = summarize(y, grid, src, today)
        st["years"] = dict(sorted(st["years"].items()))
        daily = merge_daily(st.get("daily"), grids, today)
        if daily:
            st["daily"] = daily
    link_balaton(data)
    changed = save(data, path)
    print("history:", "frissítve" if changed else "változatlan")
    return changed
