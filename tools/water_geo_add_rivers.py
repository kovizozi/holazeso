#!/usr/bin/env python3
"""A water-geo.json folyóinak kiegészítése a gyűjtő csatorna-pillanatképéből (OSM).

A water-geo.json eredetileg a Natural Earth 1:10m adatából készült (Duna, Tisza,
Dráva, ld. ARCHITECTURE.md), abban nincs benne a Duna Esztergom feletti, Győr-
Komárom közötti szakasza és a Körösök. Ezeket a worker /channels-snapshot
pillanatképéből (OpenStreetMap, ODbL) vesszük, Douglas-Peucker-egyszerűsítéssel,
ugyanabban a delta-kódolt formában (1e-3 fok), és a meglévő vonalak MÖGÉ fűzzük.

Egyszeri, kézi futtatás (a hozzáadott vonalak nem változnak):
  curl -s https://<worker>/channels-snapshot -o /tmp/channels.json
  python3 tools/water_geo_add_rivers.py /tmp/channels.json
Másodszori futás nem duplikál: a meglévő vonalakkal azonos kezdőpontú vonalat kihagyja.
"""
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GEO = ROOT / "water-geo.json"
KOROS = {"Hármas-Körös", "Kettős-Körös", "Sebes-Körös", "Fehér-Körös", "Fekete-Körös"}
TOL = 0.006          # fok; a talajtérkép országos léptékéhez elég


def decode(g, scale):
    x, y = g[0], g[1]
    pts = [(x / scale, y / scale)]
    for i in range(2, len(g) - 1, 2):
        x += g[i]
        y += g[i + 1]
        pts.append((x / scale, y / scale))
    return pts


def dp(pts, tol):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-12
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x1) - dx * (pts[i][1] - y1)) / norm
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return dp(pts[:idx + 1], tol)[:-1] + dp(pts[idx:], tol)


def encode(pts):
    q = [(round(x * 1000), round(y * 1000)) for x, y in pts]
    out = [q[0][0], q[0][1]]
    for (ax, ay), (bx, by) in zip(q, q[1:]):
        if (bx, by) != (ax, ay):
            out += [bx - ax, by - ay]
    return out


def wanted(name, pts):
    if name in KOROS:
        return True
    # a Duna csak Esztergom felett (a Natural Earth-vonal itt kezdődik: 18,85 K, 47,82 É)
    # (a szlovák határon "Dunaj / Duna" néven szerepel)
    if name in ("Duna", "Dunaj / Duna"):
        return min(x for x, _ in pts) < 18.85 and max(y for _, y in pts) > 47.6
    return False


def main():
    snap = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["geo"]
    scale, names = snap["scale"], snap["names"]
    geo = json.loads(GEO.read_text(encoding="utf-8"))
    starts = {(r[0], r[1]) for r in geo["rivers"]}
    added = 0
    for f in snap["features"]:
        name = names[f["n"]]
        if f.get("t") == "lake":
            continue
        pts = decode(f["g"], scale)
        if len(pts) < 2 or not wanted(name, pts):
            continue
        if name in ("Duna", "Dunaj / Duna"):
            pts = [p for p in pts if p[0] < 18.86]
            if len(pts) < 2:
                continue
        enc = encode(dp(pts, TOL))
        if len(enc) < 4 or (enc[0], enc[1]) in starts:
            continue
        geo["rivers"].append(enc)
        starts.add((enc[0], enc[1]))
        added += 1
    GEO.write_text(json.dumps(geo, separators=(",", ":")), encoding="utf-8")
    print(f"{added} vonal hozzáadva, {GEO.stat().st_size // 1024} kB", file=sys.stderr)


if __name__ == "__main__":
    main()
