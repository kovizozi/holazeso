#!/usr/bin/env python3
"""A hydroinfo.hu "Központi Hidrológiai Adattár" éves vízállás-archívumának importja.

Állomásonként és évenként egy statikus oldal (ISO-8859-2), napi reggeli (7 órás) mérésekkel.
A napi rácsból számol évi minimumot, maximumot (dátummal) és átlagot, és a
water-history.json fájlba írja (rendezett kulcsok, stabil kimenet: ugyanaz a bemenet
byte-azonos fájlt ad). Más forrású (src) éveket a meglévő fájlból megőriz.

Használat:
  python3 tools/import_hydro_archive.py --cache /tmp/hydro-cache            # minden állomás
  python3 tools/import_hydro_archive.py --cache DIR --stations si,bp        # csak ezek
  python3 tools/import_hydro_archive.py --cache DIR --offline               # csak gyorsítótárból

Csak stdlib. A közös rész (HTTP, összegzés, újabb táblák, napi frissítés): tools/hydro_history.py. A letöltés udvarias: 1 kérés/másodperc, újrapróbálkozással, a gyorsítótár
(--cache) a repón kívül él. A generátor (tools/build_pages.py) csak a JSON-t olvassa.
"""
import argparse
import datetime
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hydro_history as hh  # noqa: E402

BASE = "https://www.hydroinfo.hu/vituki/archivum/"
SRC = "hydroinfo-archive"
OUT = hh.OUT
STATIONS = hh.STATIONS
MONTHS = ["Jan", "Feb", "Már", "Ápr", "Máj", "Jún", "Júl", "Aug", "Sze", "Okt", "Nov", "Dec"]
MDAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def fetch(name, cache, offline):
    """Az archívum-oldal szövege (UTF-8), vagy None, ha nincs ilyen oldal."""
    data = hh.get(BASE + name, cache / name, offline)
    if data is None:
        if not offline and not (cache / (name + ".missing")).exists():
            print(f"  FIGYELEM: nem sikerült letölteni: {name}", file=sys.stderr)
        return None
    return data.decode("iso-8859-2", "replace")


def year_range(html):
    m = re.search(r"(\d{4})\s*-\s*(\d{4})", re.sub(r"<[^>]*>", " ", html))
    return (int(m.group(1)), int(m.group(2))) if m else None


def pre_text(html):
    m = re.search(r"<pre>(.*?)</pre>", html, re.S | re.I)
    return (m.group(1) if m else html).replace("\r", "")


VAL = re.compile(r"^(-?\d+)([A-Za-z]?)$")


def parse_grid(text):
    """{(hónap 1..12, nap): cm} a napi rácsból; a minőségi kód-utótagokat levágja."""
    lines = text.split("\n")
    hdr = next((ln for ln in lines if "Jan" in ln and "Dec" in ln and "Nap" in ln), None)
    out = {}
    centers = None
    if hdr and "\t" not in hdr:
        pos = hdr.index("Nap") + 3
        centers = [(t.start() + t.end()) / 2 + pos for t in re.finditer(r"\S+", hdr[pos:])]
        if len(centers) != 12:
            centers = None
    for ln in lines:
        if re.match(r"\s*(Minimum|Nap|nap)\b", ln):
            if out:
                break
            continue
        if "\t" in ln:
            cells = [c.strip() for c in ln.split("\t")]
            while cells and cells[0] == "":
                cells.pop(0)
            if not cells or not re.fullmatch(r"\d{1,2}", cells[0]):
                continue
            day, vals = int(cells[0]), cells[1:13]
            pairs = list(enumerate(vals))
        else:
            m = re.match(r"\s*(\d{1,2})(?=\s)", ln)
            if not m or centers is None:
                continue
            day = int(m.group(1))
            pairs = []
            for t in re.finditer(r"\S+", ln[m.end():]):
                mid = m.end() + (t.start() + t.end()) / 2
                col = min(range(12), key=lambda i: abs(centers[i] - mid))
                pairs.append((col, t.group()))
        if not 1 <= day <= 31:
            continue
        for col, tok in pairs:
            v = VAL.match(tok)
            if v and col < 12 and day <= MDAYS[col] and abs(int(v.group(1))) < hh.MAX_ABS_CM:
                out[(col + 1, day)] = int(v.group(1))
    return out


def printed_extremes(text):
    """Az oldalon nyomtatott éves min/max (cm), ha van."""
    t = re.sub(r"(?<=\w) (?=\w( |$))", "", text)  # "m i n i m u m" -> "minimum"
    mn = re.search(r"(?:^|\s)minimum\s+(-?\d+)(?:\s*cm)?\s+(?:\d{4}-)?[A-Za-zÁ-ű]{3}-\d\d", t, re.I | re.M)
    mx = re.search(r"(?:^|\s)maximum\s+(-?\d+)(?:\s*cm)?\s+(?:\d{4}-)?[A-Za-zÁ-ű]{3}-\d\d", t, re.I | re.M)
    return (int(mn.group(1)) if mn else None, int(mx.group(1)) if mx else None)


def zero_of(html):
    m = (re.search(r"nullpont magass\S*:\s*(-?\d+\.\d+)", html, re.I)
         or re.search(r"Nullpont\s+(-?\d+\.\d+)", html, re.I))
    return float(m.group(1)) if m else None


OWN_SRC = {SRC, "hydroinfo-tb", "hydroinfo-current", "bgld", "balaton-avg"}


def import_station(code, cache, offline, prev):
    name, water = STATIONS[code]
    today = datetime.date.today()
    years = {y: v for y, v in (prev.get("years") or {}).items() if v.get("src") not in OWN_SRC}
    zeros, missing, changes = {}, [], []
    first = last = None
    if code not in hh.TB_ONLY:  # a TB_ONLY állomásoknak nincs régi archívuma
        idx = fetch(f"{code}.htm", cache, offline)
        rng = year_range(idx) if idx else None
        if not rng:
            print(f"{code}: nincs évtartomány", file=sys.stderr)
            return prev
        first, last = rng
        raw = {}
        for y in range(first, last + 1):
            html = fetch(f"{code}{y}.htm", cache, offline)
            if not html:
                missing.append(y)
                continue
            text = pre_text(html)
            grid = parse_grid(text)
            if not grid:
                missing.append(y)
                continue
            z = zero_of(html)
            if z is not None:
                zeros[y] = z
            raw[y] = (grid, printed_extremes(text))
        # a nullpont az utolsó ismert érték; ahol a lap nem írja, a szomszédos évé érvényes
        zero_now = zeros[max(zeros)] if zeros else prev.get("zero_m")
        known = sorted(zeros)
        for y, (grid, (pmin, pmax)) in raw.items():
            zy = zeros.get(y)
            if zy is None and known:
                zy = zeros[max([k for k in known if k < y] or [known[0]])]
            shift = round((zy - zero_now) * 100) if zy is not None and zero_now is not None else 0
            s = hh.summarize(y, grid, SRC, shift=shift, zero_m=zy)
            if pmin is not None:
                s["pmin"] = pmin + shift
            if pmax is not None:
                s["pmax"] = pmax + shift
            years[str(y)] = s
    elif code == "fe":  # Fertő: 1965-2001 burgenlandi tószint, 2002-től hydroinfo
        for y in range(1965, 2002):
            cf = cache / f"bgld-{y}.txt"
            data = hh.get(hh.BGLD.format(year=y), cf, offline)
            s = hh.summarize(y, hh.parse_bgld(data, y), "bgld") if data else None
            if s and s["n"] >= 300:
                years[str(y)] = s
            else:
                missing.append(y)
        first, last = 1965, 2001
    if code in hh.TB_CODE:  # az archívum vége után az újabb táblák, a folyó évig
        start = 2002 if code in hh.TB_ONLY else last + 1
        for y in range(start, today.year + 1):
            s = hh.fetch_year_tb(code, y, today, cache, offline)
            if s:
                years[str(y)] = s
            else:
                missing.append(y)
    zero_now = zeros[max(zeros)] if zeros else prev.get("zero_m")
    cur = None
    for y in sorted(zeros):
        if zeros[y] != zero_now:
            if cur and cur["zero_m"] == zeros[y] and not any(
                    z != zeros[y] and cur["to"] < yz < y for yz, z in zeros.items()):
                cur["to"] = y
            else:
                cur = {"from": y, "to": y, "zero_m": zeros[y]}
                changes.append(cur)
    st = {"name": name, "water": water, "unit": "cm",
          "years": dict(sorted(years.items())), "zero_changes": changes}
    if zero_now is not None:
        st["zero_m"] = zero_now
    if prev.get("daily"):       # a napi sort a hydro_history.refresh_current kezeli
        st["daily"] = prev["daily"]
    ys = sorted(int(y) for y in years)
    print(f"{code}: archívum {first}-{last}, összesen {len(years)} év ({ys[0] if ys else '-'}-{ys[-1] if ys else '-'}), "
          f"hiányzik: {missing or '-'}, nullpont {zero_now}, eltérő nullpont: {changes or '-'}")
    return st


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default="/tmp/hydro-archive-cache", help="letöltési gyorsítótár (a repón kívül)")
    ap.add_argument("--stations", default=",".join(STATIONS))
    ap.add_argument("--offline", action="store_true", help="csak a gyorsítótárból dolgozik")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    data = hh.load(a.out)
    for code in a.stations.split(","):
        data.setdefault("stations", {})[code] = import_station(
            code, cache, a.offline, data.get("stations", {}).get(code, {}))
        hh.link_balaton(data)
        hh.save(data, a.out)  # állomásonként mentünk, megszakítás után is használható


if __name__ == "__main__":
    main()
