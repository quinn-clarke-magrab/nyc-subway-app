#!/usr/bin/env python3
"""Rebuild src/geo.js — subway route lines and the city shoreline.

Pulls two open datasets, simplifies them hard enough to ship in a static page,
and writes the delta-encoded result that src/app.js decodes at load.

    python3 scripts/build_geo.py

Needs network access. The committed src/geo.js is the output of this script, so
you only need to run it if the source data changes or you want different
fidelity (see TOLERANCE constants below).
"""

import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "geo.js"

ROUTES_URL = "https://data.ny.gov/resource/s692-irgq.json?$limit=100"
LAND_URL = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson?$limit=10"

# One entry per color on the MTA map, not per service: the 1/2/3 draw a single
# red trunk, the way they do on the wall map.
COLOR_OF = {
    "1": "red", "2": "red", "3": "red",
    "4": "green", "5": "green", "5 Peak": "green", "6": "green",
    "7": "purple",
    "A": "blue", "C": "blue", "E": "blue",
    "B": "orange", "D": "orange", "F": "orange", "M": "orange",
    "G": "lime",
    "J": "brown", "Z": "brown",
    "L": "grey",
    "N": "yellow", "Q": "yellow", "R": "yellow", "W": "yellow",
    "S": "slate", "SF": "slate", "ST": "slate", "SR": "slate",
    "SIR": "sir",
}
COLOR_ORDER = [
    "red", "green", "purple", "blue", "orange",
    "lime", "brown", "grey", "yellow", "slate", "sir",
]

ROUTE_TOLERANCE = 0.00002   # ~2 m — routes keep their curves
DEDUPE_TOLERANCE = 0.0004   # how close counts as "already drawn"
DEDUPE_COVERAGE = 0.9       # drop a line this much of which is already drawn

# The shoreline is built by rasterising rather than by simplifying each borough
# polygon. Simplifying them separately tears open the borders they share —
# Brooklyn and Queens drift apart and a stripe of water appears between them.
# Painting all five into one bitmap dissolves those borders before any
# simplification happens, which is also how the wall map treats the city: one
# landmass, not five.
METRES_PER_PIXEL = 60       # raster resolution
OPEN_RADIUS = 2             # shaves piers, jetties and specks (~120 m)
MIN_COMPONENT_PX = 150      # drop islands below ~0.5 km² (keeps Roosevelt I.)
LAND_TOLERANCE = 0.0009     # ~100 m — knocks the wiggle out of the coast
SMOOTH_PASSES = 2           # Chaikin rounds the raster staircase into curves
LAND_TRIM_TOLERANCE = 0.00015  # drops points smoothing made redundant

LAT0 = 40.72
KX = math.cos(math.radians(LAT0))  # squash longitude so distances are comparable

# Chosen to avoid backslashes and quotes, which would need escaping in JS source.
ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-"


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return json.load(response)


def sq_seg_dist(p, a, b):
    x, y = a[0] * KX, a[1]
    dx, dy = b[0] * KX - x, b[1] - y
    if dx or dy:
        t = ((p[0] * KX - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
        if t > 1:
            x, y = b[0] * KX, b[1]
        elif t > 0:
            x += dx * t
            y += dy * t
    ex, ey = p[0] * KX - x, p[1] - y
    return ex * ex + ey * ey


def simplify(points, tolerance):
    """Douglas-Peucker, iterative so long lines can't blow the stack."""
    if len(points) < 3:
        return list(points)
    sq = tolerance * tolerance
    last = len(points) - 1
    keep = [False] * len(points)
    keep[0] = keep[last] = True
    stack = [(0, last)]
    while stack:
        start, end = stack.pop()
        furthest, index = 0.0, -1
        for i in range(start + 1, end):
            d = sq_seg_dist(points[i], points[start], points[end])
            if d > furthest:
                furthest, index = d, i
        if furthest > sq and index > 0:
            keep[index] = True
            stack.append((start, index))
            stack.append((index, end))
    return [p for p, k in zip(points, keep) if k]


def encode(points):
    """Zig-zag delta varints at 1e-5 degrees, 5 data bits per character."""
    out = []
    prev_lat = prev_lon = 0
    for lon, lat in points:
        for value in (round(lat * 1e5) - prev_lat, round(lon * 1e5) - prev_lon):
            v = ~(value << 1) if value < 0 else (value << 1)
            while v >= 0x20:
                out.append(ALPHA[0x20 | (v & 0x1F)])
                v >>= 5
            out.append(ALPHA[v])
        prev_lat = round(lat * 1e5)
        prev_lon = round(lon * 1e5)
    return "".join(out)


def decode(encoded):
    """Inverse of encode(); used by the self-check below and by src/app.js."""
    index = {c: i for i, c in enumerate(ALPHA)}
    points = []
    i = lat = lon = 0
    while i < len(encoded):
        values = []
        for _ in range(2):
            result = shift = 0
            while True:
                chunk = index[encoded[i]]
                i += 1
                result |= (chunk & 0x1F) << shift
                shift += 5
                if chunk < 0x20:
                    break
            values.append(~(result >> 1) if result & 1 else result >> 1)
        lat += values[0]
        lon += values[1]
        points.append((lon / 1e5, lat / 1e5))
    return points


def chaikin(ring, passes):
    """Corner cutting on a closed ring: replaces the raster staircase with curves."""
    for _ in range(passes):
        out = []
        for i, a in enumerate(ring):
            b = ring[(i + 1) % len(ring)]
            out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        ring = out
    return ring


def outer_rings(geojson):
    for feature in geojson["features"]:
        geometry = feature["geometry"]
        coords = geometry["coordinates"]
        polygons = coords if geometry["type"] == "MultiPolygon" else [coords]
        for polygon in polygons:
            yield polygon[0]


def rasterise(rings, bounds, width, height):
    """Scanline-fill every ring into one shared bitmap, dissolving the borders."""
    lat0, lat1, lon0, lon1 = bounds
    grid = bytearray(width * height)
    edges_by_row = [[] for _ in range(height)]

    for ring in rings:
        pixels = [
            (
                (lon - lon0) / (lon1 - lon0) * width,
                (lat1 - lat) / (lat1 - lat0) * height,
            )
            for lon, lat in ring
        ]
        for i, (x0, y0) in enumerate(pixels):
            x1, y1 = pixels[(i + 1) % len(pixels)]
            if y0 == y1:
                continue
            top, bottom = (y0, y1) if y0 < y1 else (y1, y0)
            first = max(0, math.ceil(top - 0.5))
            last = min(height - 1, math.floor(bottom - 0.5))
            for row in range(first, last + 1):
                y = row + 0.5
                if not (top <= y < bottom):
                    continue
                x = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
                edges_by_row[row].append(x)

    for row, crossings in enumerate(edges_by_row):
        if not crossings:
            continue
        crossings.sort()
        for i in range(0, len(crossings) - 1, 2):
            start = max(0, math.ceil(crossings[i] - 0.5))
            end = min(width - 1, math.floor(crossings[i + 1] - 0.5))
            base = row * width
            for x in range(start, end + 1):
                grid[base + x] = 1
    return grid


def morph(grid, width, height, radius, dilate):
    """Separable square-kernel dilate (dilate=True) or erode."""
    tmp = bytearray(width * height)
    out = bytearray(width * height)
    for y in range(height):
        base = y * width
        for x in range(width):
            value = 0 if dilate else 1
            for dx in range(-radius, radius + 1):
                xx = x + dx
                if xx < 0 or xx >= width:
                    if not dilate:
                        value = 0
                    continue
                cell = grid[base + xx]
                value = (value | cell) if dilate else (value & cell)
            tmp[base + x] = value
    for y in range(height):
        for x in range(width):
            value = 0 if dilate else 1
            for dy in range(-radius, radius + 1):
                yy = y + dy
                if yy < 0 or yy >= height:
                    if not dilate:
                        value = 0
                    continue
                cell = tmp[yy * width + x]
                value = (value | cell) if dilate else (value & cell)
            out[y * width + x] = value
    return out


def components(grid, width, height):
    """Flood fill into labelled blobs; returns (label array, [(size, seed)])."""
    labels = [-1] * (width * height)
    found = []
    for start in range(width * height):
        if not grid[start] or labels[start] >= 0:
            continue
        ident = len(found)
        labels[start] = ident
        stack = [start]
        size = 0
        seed = start
        while stack:
            p = stack.pop()
            size += 1
            if p < seed:
                seed = p
            x = p % width
            for q, ok in (
                (p - 1, x > 0),
                (p + 1, x < width - 1),
                (p - width, p >= width),
                (p + width, p < width * (height - 1)),
            ):
                if ok and grid[q] and labels[q] < 0:
                    labels[q] = ident
                    stack.append(q)
        found.append((size, seed, ident))
    return labels, found


# Moore neighbourhood, clockwise from west.
NEIGHBOURS = [(-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1)]


def trace(labels, width, height, ident, seed):
    """Moore-neighbour boundary following, from the blob's topmost-leftmost pixel."""
    sx, sy = seed % width, seed // width
    px, py, back = sx, sy, 0
    path = [(px, py)]
    for _ in range(400000):
        moved = False
        for step in range(1, 9):
            d = (back + step) % 8
            nx, ny = px + NEIGHBOURS[d][0], py + NEIGHBOURS[d][1]
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                continue
            if labels[ny * width + nx] != ident:
                continue
            back = (d + 4) % 8
            px, py = nx, ny
            path.append((px, py))
            moved = True
            break
        if not moved:
            break
        if (px, py) == (sx, sy) and len(path) > 3:
            path.pop()
            break
    return path


def build_routes(rows):
    grouped = {}
    for row in rows:
        color = COLOR_OF.get(row.get("service"))
        geometry = row.get("geometry")
        if not color or not geometry:
            continue
        coords = geometry["coordinates"]
        lines = coords if geometry["type"] == "MultiLineString" else [coords]
        for line in lines:
            if len(line) > 1:
                grouped.setdefault(color, []).append(simplify(line, ROUTE_TOLERANCE))

    routes = {}
    for color, parts in grouped.items():
        # Longest first, then drop anything already covered: the 1/2/3 share the
        # 7th Avenue trunk, and drawing it three times is wasted bytes.
        parts.sort(key=len, reverse=True)
        drawn = set()
        kept = []

        def cell(point):
            return (
                round(point[0] * KX / DEDUPE_TOLERANCE),
                round(point[1] / DEDUPE_TOLERANCE),
            )

        for part in parts:
            hits = 0
            for point in part:
                cx, cy = cell(point)
                if any(
                    (cx + i, cy + j) in drawn
                    for i in (-1, 0, 1)
                    for j in (-1, 0, 1)
                ):
                    hits += 1
            if hits / len(part) >= DEDUPE_COVERAGE:
                continue
            kept.append(part)
            drawn.update(cell(point) for point in part)
        routes[color] = [encode(part) for part in kept]
    return routes


def build_land(geojson):
    rings = list(outer_rings(geojson))

    pad = 0.004
    lats = [lat for ring in rings for _, lat in ring]
    lons = [lon for ring in rings for lon, _ in ring]
    lat0, lat1 = min(lats) - pad, max(lats) + pad
    lon0, lon1 = min(lons) - pad, max(lons) + pad

    km_per_lon = 111.32 * KX
    width = round((lon1 - lon0) * km_per_lon * 1000 / METRES_PER_PIXEL)
    height = round((lat1 - lat0) * 111.32 * 1000 / METRES_PER_PIXEL)
    bounds = (lat0, lat1, lon0, lon1)

    grid = rasterise(rings, bounds, width, height)
    # Opening only. A closing pass would be tempting to fill narrow inlets, but
    # the Harlem River is barely 150 m across and closing welds Manhattan onto
    # the Bronx.
    grid = morph(grid, width, height, OPEN_RADIUS, dilate=False)
    grid = morph(grid, width, height, OPEN_RADIUS, dilate=True)

    labels, blobs = components(grid, width, height)
    blobs.sort(reverse=True)

    out = []
    for size, seed, ident in blobs:
        if size < MIN_COMPONENT_PX:
            continue
        path = trace(labels, width, height, ident, seed)
        if len(path) < 12:
            continue
        ring = [
            (
                lon0 + (x + 0.5) / width * (lon1 - lon0),
                lat1 - (y + 0.5) / height * (lat1 - lat0),
            )
            for x, y in path
        ]
        ring = simplify(ring, LAND_TOLERANCE)
        ring = chaikin(ring, SMOOTH_PASSES)
        ring = simplify(ring, LAND_TRIM_TOLERANCE)
        out.append(encode(ring))
    return out


def self_check(routes, land):
    """Every encoded string must decode back inside the New York area."""
    everything = [s for group in routes.values() for s in group] + land
    for encoded in everything:
        for lon, lat in decode(encoded):
            if not (40.4 < lat < 41.0 and -74.35 < lon < -73.6):
                sys.exit(f"decoded a point outside New York: {lat}, {lon}")
    return sum(len(decode(s)) for s in everything)


def main():
    routes = build_routes(fetch(ROUTES_URL))
    land = build_land(fetch(LAND_URL))
    points = self_check(routes, land)

    lines = [
        "// GENERATED by scripts/build_geo.py — route + shoreline geometry.",
        "// Routes: MTA Subway Service Lines (data.ny.gov s692-irgq), one entry per map color.",
        "// Land: NYC Borough Boundaries (data.cityofnewyork.us gthc-hcne), outer rings only.",
        "// Coordinates are delta-encoded at 1e-5 degrees; see decodePath() in src/app.js.",
        "window.SUBWAY_GEO = {",
        "  routes: {",
    ]
    for color in COLOR_ORDER:
        if color not in routes:
            continue
        lines.append(f"    {color}: [")
        lines.extend(f'      "{s}",' for s in routes[color])
        lines.append("    ],")
    lines.append("  },")
    lines.append("  land: [")
    lines.extend(f'    "{s}",' for s in land)
    lines.append("  ],")
    lines.append("};")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(land)} shoreline rings and "
          f"{sum(len(v) for v in routes.values())} route lines "
          f"({points} points) to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
