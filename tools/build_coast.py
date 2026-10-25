"""Build NextMark's bundled world coastline.

Input : ne_10m_coastline.geojson (Natural Earth, public domain)
Output: coast-world.json  -> {"tiles": {"<lon>_<lat>": ["<encoded polyline>", ...]}, ...}

Tiles are 10 deg cells keyed by the SW corner. Each line is clipped to the cells
it crosses so the app only ever decodes coast near the boat. Geometry is
Douglas-Peucker simplified then stored as a precision-4 encoded polyline
(1e-4 deg ~ 11 m, far finer than the source data's own vertex spacing).
"""
import json, math, sys

TILE = 10.0
PREC = 1e4


def load_lines(path):
    src = json.load(open(path, encoding="utf-8"))
    out = []
    for f in src["features"]:
        g = f.get("geometry")
        if not g:
            continue
        if g["type"] == "LineString":
            out.append(g["coordinates"])
        elif g["type"] == "MultiLineString":
            out.extend(g["coordinates"])
    return out


def seg_dist_deg(p, a, b, kx):
    """Perp distance p->ab in degree space, longitude scaled by kx."""
    px, py = (p[0] - a[0]) * kx, p[1] - a[1]
    bx, by = (b[0] - a[0]) * kx, b[1] - a[1]
    L = bx * bx + by * by
    if L == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / L))
    return math.hypot(px - t * bx, py - t * by)


def rdp(pts, tol_deg, kx):
    """Iterative Douglas-Peucker (recursion blows the stack on long coasts)."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        worst, wi = -1.0, -1
        a, b = pts[i], pts[j]
        for k in range(i + 1, j):
            d = seg_dist_deg(pts[k], a, b, kx)
            if d > worst:
                worst, wi = d, k
        if worst > tol_deg:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [pts[i] for i in range(n) if keep[i]]


def encode(pts):
    """Google encoded polyline, precision 4, lat then lon."""
    out, plat, plon = [], 0, 0
    for lon, lat in pts:
        la = int(round(lat * PREC))
        lo = int(round(lon * PREC))
        for v in (la - plat, lo - plon):
            v = ~(v << 1) if v < 0 else (v << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = la, lo
    return "".join(out)


def cell_key(lon, lat):
    return "%d_%d" % (math.floor(lon / TILE) * TILE, math.floor(lat / TILE) * TILE)


def split_to_tiles(pts):
    """Break a line wherever it changes 10deg cell. The crossing segment is kept
    in both cells so adjacent tiles draw as one unbroken coast."""
    runs = []
    key = cell_key(pts[0][0], pts[0][1])
    cur = [pts[0]]
    for i in range(1, len(pts)):
        p = pts[i]
        k = cell_key(p[0], p[1])
        if k == key:
            cur.append(p)
            continue
        cur.append(p)            # finish this cell's run inside the next cell
        runs.append((key, cur))
        cur = [pts[i - 1], p]    # start the next run one vertex back
        key = k
    if len(cur) >= 2:
        runs.append((key, cur))
    return runs


def main():
    tol_m = float(sys.argv[1]) if len(sys.argv) > 1 else 400.0
    lines = load_lines("ne10m.geojson")
    tol_deg = tol_m / 111320.0
    tiles = {}
    kept = dropped = vin = vout = 0
    for l in lines:
        vin += len(l)
        kx = math.cos(math.radians(sum(p[1] for p in l) / len(l)))
        s = rdp(l, tol_deg, max(kx, 0.05))
        if len(s) < 2:
            dropped += 1
            continue
        kept += 1
        vout += len(s)
        for key, run in split_to_tiles(s):
            if len(run) < 2:
                continue
            tiles.setdefault(key, []).append(encode(run))

    doc = {
        "source": "Natural Earth 10m coastline (public domain)",
        "tile_deg": TILE,
        "precision": 4,
        "simplify_m": tol_m,
        "tiles": tiles,
    }
    txt = json.dumps(doc, separators=(",", ":"))
    open("coast-world.json", "w", encoding="utf-8").write(txt)
    print("lines kept %d dropped %d" % (kept, dropped))
    print("vertices %d -> %d (%.1f%%)" % (vin, vout, 100.0 * vout / vin))
    print("tiles %d" % len(tiles))
    print("bytes %d (%.0f KB)" % (len(txt.encode()), len(txt.encode()) / 1024))


if __name__ == "__main__":
    main()
