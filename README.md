# NYC Subway Tracker

An interactive map of the New York City subway where you tick off every stop you've been to.

The map is drawn from scratch in the style of the wall map — cream land, light blue water, thick
colored trunk lines, hollow station ticks that fill in solid once you've been there. The city is
rotated so Manhattan runs straight up the page, the way the official map turns it.

## Running it

There's no build step and no dependencies to install. Open `index.html` in a browser:

```bash
open index.html
```

That's it. Leaflet loads from a CDN; everything else — stations, route lines, shoreline — is in the
repo. There are no map tiles, so no API key, no account and no tile server to pay for. Your
progress is saved in the browser's `localStorage`; nothing is uploaded anywhere.

If your browser is fussy about `file://` URLs, serve the folder instead:

```bash
python3 -m http.server 8000
```

## Features

- **424 stops.** Every station complex except the Staten Island Railway (see below). Transfer
  complexes count once — Times Sq-42 St is one stop, not five.
- **Filter** by line, by borough, or by whether you've been there.
- **Search** station names and routes (press `/` to jump to the box).
- **Breakdown** tab with per-line and per-borough progress bars.
- **Surprise me** picks a random stop you haven't visited yet.
- **Export / import** your progress as JSON, to move it between browsers or back it up.

## Things you might want to change

All in `src/app.js`:

```js
var INCLUDE_STATEN_ISLAND = false;  // true puts the SIR's 21 stops back on the map
var ROTATION_DEG = 23;              // 0 gives you true north instead
var FISHEYE = 0.8;                  // 0 gives true proportions
var FISHEYE_ORIGIN = { lat: 40.758, lon: -73.979 };
```

`FISHEYE` is the wall map's other liberty with geography: the middle of the city is drawn larger
than scale so the dense part stays legible, and the outer boroughs tighten up to make room.
Distance `d` from the origin becomes `d(1+k) / (1 + k·d/span)` — smooth, never folds back on
itself, and pins the outermost point in place so magnifying the middle can't push the edges off
the map.

Rotation and magnification are applied to the coordinates, not to the rendered map, so clicking
stays exactly in step with what's drawn whatever you set them to.

## Project layout

```
index.html                 markup and CDN script tags
src/styles.css             all styling
src/app.js                 projection, map, filtering, stats, persistence
src/stations.js            GENERATED station data — do not edit by hand
src/geo.js                 GENERATED route + shoreline geometry — likewise
data/stations.txt          the station data, pipe-delimited and editable
scripts/build_stations.py  data/stations.txt  ->  src/stations.js
scripts/build_geo.py       open data APIs     ->  src/geo.js  (needs network)
```

Both generated files are committed so the page works with no build step. Regenerate after editing
the station list:

```bash
python3 scripts/build_stations.py
```

## Where the data comes from

| What | Source |
| --- | --- |
| Stations | [MTA Subway Stations](https://data.ny.gov/d/39hk-dx4f), grouped by `complex_id` |
| Route lines | [MTA Subway Service Lines](https://data.ny.gov/d/s692-irgq) |
| Shoreline | [NYC Borough Boundaries](https://data.cityofnewyork.us/d/gthc-hcne) |

Station rows are `id|name|borough|routes|lat|lon|ada`; boroughs are `M`, `Bk`, `Q`, `Bx`, `SI`.
Coordinates for a complex are the average of its platforms, so the tick sits over the middle of the
complex rather than over one entrance.

Route lines are grouped by *color* rather than by service, so the 1/2/3 share one red trunk exactly
as they do on the wall map, and track already drawn by another service is dropped. They keep their
real curves (simplified to ~2 m) so the station ticks sit on them properly.

The shoreline gets the opposite treatment, because the wall map's coast is a handful of smooth
shapes rather than every pier and inlet. Simplifying the five borough polygons one at a time tears
open the borders they share — Brooklyn and Queens drift apart and a stripe of water appears down
the middle — so `build_geo.py` paints all five into a 60 m-per-pixel bitmap first. That dissolves
the internal borders into a single landmass, which is how the wall map treats the city anyway. A
morphological opening then shaves off piers, jetties and specks, blobs under about 0.5 km² are
dropped, the outlines are traced, simplified to ~100 m, and rounded with two passes of Chaikin
corner-cutting.

There's deliberately no closing pass to fill narrow inlets: the Harlem River is barely 150 m
across, and closing welds Manhattan onto the Bronx.

Everything is delta-encoded at 1e-5 degrees, which gets the whole network and coastline into about
17 KB.

Central Park is drawn from its four real corners, in the `PARKS` array in `src/app.js` — add more
entries there for Prospect Park, Flushing Meadows and the rest.

## Deploying

It's a static site, so GitHub Pages works with no configuration: **Settings → Pages → Deploy from a
branch → `main` / `/ (root)`**.

## License

MIT. The underlying data is published by the MTA, New York State and the City of New York; the
route colors and station names are theirs.
