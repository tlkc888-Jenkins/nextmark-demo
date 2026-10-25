"""Build a course pack's high-detail coastline from an Overpass natural=coastline dump.

This is the ingestion-time step: a pack covers one race area, so its coast is
clipped to that area and simplified to a tolerance that still looks right at
race scale (a few hundred metres across the screen).

Usage: python build_pack_coast.py osm_gc.json coast-sailparadise.json 25
"""
import json, math, sys

from build_coast import rdp, encode  # reuse the simplifier and encoder

src_path, out_path = sys.argv[1], sys.argv[2]
TOL_M = float(sys.argv[3]) if len(sys.argv) > 3 else 25.0

doc = json.load(open(src_path, encoding="utf-8"))
nodes, ways = {}, []
for e in doc["elements"]:
    if e["type"] == "node":
        nodes[e["id"]] = (e["lon"], e["lat"])
    elif e["type"] == "way" and e.get("nodes"):
        ways.append(e["nodes"])

print("osm nodes %d ways %d" % (len(nodes), len(ways)))

# stitch ways end-to-end into continuous coastline strings
by_start = {}
for w in ways:
    by_start.setdefault(w[0], []).append(w)

used, lines = set(), []
for i, w in enumerate(ways):
    if i in used:
        continue
    chain = list(w)
    used.add(i)
    grew = True
    while grew:
        grew = False
        for j, w2 in enumerate(ways):
            if j in used:
                continue
            if w2[0] == chain[-1]:
                chain.extend(w2[1:]); used.add(j); grew = True
            elif w2[-1] == chain[0]:
                chain = w2[:-1] + chain; used.add(j); grew = True
    pts = [nodes[n] for n in chain if n in nodes]
    if len(pts) >= 2:
        lines.append(pts)

vin = sum(len(l) for l in lines)
tol = TOL_M / 111320.0
out, vout = [], 0
for l in lines:
    kx = math.cos(math.radians(sum(p[1] for p in l) / len(l)))
    s = rdp(l, tol, max(kx, 0.05))
    if len(s) < 2:
        continue
    vout += len(s)
    out.append(encode(s))

pack = {
    "source": "OpenStreetMap contributors (ODbL) via Overpass",
    "attribution": "© OpenStreetMap contributors",
    "precision": 4,
    "simplify_m": TOL_M,
    "lines": out,
}
txt = json.dumps(pack, separators=(",", ":"))
open(out_path, "w", encoding="utf-8").write(txt)
print("stitched lines %d | vertices %d -> %d" % (len(lines), vin, vout))
print("bytes %d (%.0f KB)" % (len(txt.encode()), len(txt.encode()) / 1024))
