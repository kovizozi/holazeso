#!/usr/bin/env python3
"""Éghajlati hőtérképek adata (/eghajlat/): data/eghajlat.json.

Forrás: HungaroMet Meteorológiai Adattár (odp.met.hu), homogenizált napi állomási
adatsorok 1901-től, 10 állomás (csapadék, közép-, maximum- és minimumhőmérséklet).
Felhasználási feltétel: a forrást fel kell tüntetni ("Adatbázis: Meteorológiai
Adattár, HungaroMet Nonprofit Zrt."), átlagolt, simított származtatásnál is.

Minden ábra ugyanígy készül:
  1. napi mérőszám a 10 állomás átlagaként (pl. hány nap telt el az utolsó
     legalább 1 mm-es eső óta, vagy a napok hány százaléka volt hőségnap);
  2. évenként 73 darab 5 napos sáv átlaga;
  3. Gauss-simítás két irányban (három választható fokozatban, SMOOTH): az évszak
     mentén a FOLYTONOS idősoron (így a december simán átfolyik a következő év
     januárjába), majd az évek mentén;
  4. sávonként a 125 éves átlagtól való eltérés (anom) és maga az átlag (clim).

Az évente egyszer frissülő forrás miatt kézzel futtatandó (a folyó év a
következő év elején kerül be):
  python3 tools/import_climate_trends.py --cache /tmp/climate-cache
  python3 tools/build_pages.py
Csak szabványos könyvtár.
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
import pathlib
import statistics
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "eghajlat.json"
BASE = "https://odp.met.hu/climate/homogenized_data/station_data_series/from_1901/"
STATIONS = ["Budapest", "Debrecen", "Keszthely", "Miskolc", "Nyiregyhaza", "Pecs", "Sopron",
            "Szeged", "Szombathely", "Turkeve"]
# mérőszám -> (mappa, fájl-előtag)
VARS = {"r": ("precipitation_sum", "r"), "t": ("mean_temperature", "t"),
        "tx": ("maximum_temperature", "tx"), "tn": ("minimum_temperature", "tn")}
Y0, Y1 = 1901, 2025
NB = 73                 # 5 napos sávok egy évben
# simítási fokozatok: (szigma sávban az évszak mentén, szigma évben); az oldalon választható
SMOOTH = {"enyhe": (3, 4), "kozepes": (4, 8), "eros": (6, 12)}
WET_MM = 1.0
UA = "holazeso-climate-import (+https://holazeso.hu)"


def fetch_station(cache, var, station):
    folder, prefix = VARS[var]
    name = f"{prefix}_h_{station}_{Y0}{Y1}.csv.zip"
    path = cache / name
    if not path.exists():
        req = urllib.request.Request(BASE + f"{folder}/{name}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    with zipfile.ZipFile(path) as z:
        text = z.read(z.namelist()[0]).decode("latin-1")
    data = {}
    for row in csv.reader(io.StringIO(text), delimiter=";"):
        if row and row[0].strip().isdigit():
            data[row[0].strip()] = float(row[1])
    return data


def five_day_bins(days, values):
    """A napi sorból évenként 73 sáv átlaga, egyetlen folytonos listában (év*73+sáv)."""
    idx = {d: i for i, d in enumerate(days)}
    seq = []
    for y in range(Y0, Y1 + 1):
        s0 = idx[f"{y}0101"]
        n = 366 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 365
        for b in range(NB):
            a, e = s0 + round(b * n / NB), s0 + round((b + 1) * n / NB)
            seq.append(sum(values[a:e]) / (e - a))
    return seq


def gauss(sig, get, n):
    r = int(3 * sig)
    w = [math.exp(-(k * k) / (2 * sig * sig)) for k in range(-r, r + 1)]
    out = []
    for i in range(n):
        s = ws = 0.0
        for k in range(-r, r + 1):
            x = get(i + k)
            if x is not None:
                s += x * w[k + r]
                ws += w[k + r]
        out.append(s / ws)
    return out


def smooth(seq, level):
    """Simított rács: G[sáv][év]."""
    sig_season, sig_years = SMOOTH[level]
    a = gauss(sig_season, lambda j: seq[j] if 0 <= j < len(seq) else None, len(seq))
    ny = Y1 - Y0 + 1
    grid = []
    for b in range(NB):
        row = [a[y * NB + b] for y in range(ny)]
        grid.append(gauss(sig_years, lambda j, row=row: row[j] if 0 <= j < ny else None, ny))
    return grid


def as_chart(grid, digits):
    """clim: a sáv 125 éves átlaga; anom: eltérés egész számként (érték * 10^digits), a fájlméret miatt."""
    clim = [sum(r) / len(r) for r in grid]
    k = 10 ** digits
    anom = [[round((x - clim[b]) * k) for x in r] for b, r in enumerate(grid)]
    flat = sorted(abs(x) for r in anom for x in r)
    p95 = flat[int(len(flat) * 0.95)] / k
    return {"clim": [round(c, digits) for c in clim], "anom": anom, "k": k, "scale": round(p95, digits + 1)}


def frost_dates(tn):
    """Évenként az utolsó tavaszi és az első őszi fagy (Tmin < 0) napja, állomásátlag, simítva."""
    last, first = [], []
    for y in range(Y0, Y1 + 1):
        lo, fi = [], []
        jan1 = dt.date(y, 1, 1)
        doy = lambda d: (dt.date(int(d[:4]), int(d[4:6]), int(d[6:])) - jan1).days
        for st in tn:
            ys = [d for d in st if d.startswith(str(y)) and st[d] < 0]
            spring = [d for d in ys if d[4:6] < "07"]
            autumn = [d for d in ys if d[4:6] >= "07"]
            if spring:
                lo.append(doy(max(spring)))
            if autumn:
                fi.append(doy(min(autumn)))
        last.append(statistics.mean(lo))
        first.append(statistics.mean(fi))
    ny = len(last)
    out = {}
    for level, (_, sig_years) in SMOOTH.items():
        sm = lambda s: [round(x, 1) for x in gauss(sig_years, lambda j: s[j] if 0 <= j < ny else None, ny)]
        out[level] = {"last": sm(last), "first": sm(first)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True, help="a letöltött zip-ek mappája")
    args = ap.parse_args()
    cache = pathlib.Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    raw = {v: [fetch_station(cache, v, s) for s in STATIONS] for v in VARS}
    days = sorted(raw["r"][0])
    for v, sts in raw.items():
        for s, st in zip(STATIONS, sts):
            assert len(st) == len(days), f"{v} {s}: {len(st)} nap, várt {len(days)}"
    n = len(STATIONS)
    mean = lambda v, d: sum(st[d] for st in raw[v]) / n
    share = lambda v, d, f: sum(1 for st in raw[v] if f(st[d])) / n * 100

    # napok az utolsó (>= 1 mm) eső óta, állomásonként, majd átlag
    since = [0.0] * len(days)
    for st in raw["r"]:
        run = 0
        for i, d in enumerate(days):
            run = run + 1 if st[d] < WET_MM else 0
            since[i] += run / n
    rain = [mean("r", d) for d in days]
    wet = [share("r", d, lambda x: x >= WET_MM) / 100 for d in days]

    series = {
        "szaraz": (five_day_bins(days, since), 1),
        "homerseklet": (five_day_bins(days, [mean("t", d) for d in days]), 2),
        "hoseg": (five_day_bins(days, [share("tx", d, lambda x: x >= 30) for d in days]), 1),
        "tropusi": (five_day_bins(days, [share("tn", d, lambda x: x >= 20) for d in days]), 1),
        "fagy": (five_day_bins(days, [share("tn", d, lambda x: x < 0) for d in days]), 1),
    }
    b_rain, b_wet = five_day_bins(days, rain), five_day_bins(days, wet)
    charts = {}
    for cid in ["szaraz", "heves", "homerseklet", "hoseg", "tropusi", "fagy"]:
        charts[cid] = {}
        for level in SMOOTH:
            if cid == "heves":
                # esős napra jutó csapadék: a simított összeg / a simított esős napok aránya
                g_rain, g_wet = smooth(b_rain, level), smooth(b_wet, level)
                charts[cid][level] = as_chart([[r / w for r, w in zip(rr, ww)]
                                               for rr, ww in zip(g_rain, g_wet)], 2)
            else:
                seq, digits = series[cid]
                charts[cid][level] = as_chart(smooth(seq, level), digits)

    # évenkénti összesítők (táblázat, pontdiagramok): 10 állomás átlaga
    years = range(Y0, Y1 + 1)
    by_year = {y: [d for d in days if d.startswith(str(y))] for y in years}
    summer = lambda ds: [d for d in ds if d[4:6] in ("06", "07", "08")]
    st_mean = statistics.mean
    per_station = lambda v, ds, f: st_mean(f(st, ds) for st in raw[v])
    count = lambda c: (lambda st, ds: sum(1 for d in ds if c(st[d])))
    total = lambda st, ds: sum(st[d] for d in ds)
    since_by_day = dict(zip(days, since))
    yearly = {
        "t_ev": [round(st_mean(mean("t", d) for d in by_year[y]), 2) for y in years],
        "t_nyar": [round(st_mean(mean("t", d) for d in summer(by_year[y])), 2) for y in years],
        "hoseg": [round(per_station("tx", by_year[y], count(lambda x: x >= 30)), 1) for y in years],
        "tropusi": [round(per_station("tn", by_year[y], count(lambda x: x >= 20)), 1) for y in years],
        "fagy": [round(per_station("tn", by_year[y], count(lambda x: x < 0)), 1) for y in years],
        "csap": [round(per_station("r", by_year[y], total), 1) for y in years],
        "csap_nyar": [round(per_station("r", summer(by_year[y]), total), 1) for y in years],
        "esonap": [round(per_station("r", by_year[y], count(lambda x: x >= WET_MM)), 1) for y in years],
        "szaraz": [round(st_mean(since_by_day[d] for d in by_year[y]), 2) for y in years],
    }
    yearly["intenz"] = [round(c / w, 2) for c, w in zip(yearly["csap"], yearly["esonap"])]

    out = {"y0": Y0, "y1": Y1, "nb": NB, "levels": list(SMOOTH), "default": "kozepes", "charts": charts, "yearly": yearly, "frost": frost_dates(raw["tn"]),
           "source": "Adatbázis: Meteorológiai Adattár, HungaroMet Nonprofit Zrt.",
           "stations": STATIONS}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1024} kB, "
          + ", ".join(f"{k} skála {c['kozepes']['scale']}" for k, c in charts.items()), file=sys.stderr)


if __name__ == "__main__":
    main()
