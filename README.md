# NYC Subway Tracker

An interactive map of the New York City subway where you tick off every stop you've been to.

All 445 station complexes — every line plus the Staten Island Railway. Click a dot on the map or a
checkbox in the list, and watch the percentage climb.

## Running it

There's no build step and no dependencies to install. Open `index.html` in a browser:

```bash
open index.html
```

That's it. Leaflet loads from a CDN, the map tiles come from OpenStreetMap, and your progress is
saved in the browser's `localStorage` — nothing is uploaded anywhere.

If your browser is fussy about `file://` URLs, serve the folder instead:

```bash
python3 -m http.server 8000
```

## Features

- **445 station complexes.** Transfer complexes count once — Times Sq-42 St is one stop, not five.
- **Filter** by line, by borough, or by whether you've been there.
- **Search** station names and routes (press `/` to jump to the box).
- **Breakdown** tab with per-line and per-borough progress bars.
- **Surprise me** picks a random stop you haven't visited yet.
- **Export / import** your progress as JSON, so you can move it between browsers or back it up.

## Project layout

```
index.html                 markup and CDN script tags
src/styles.css             all styling (dark theme)
src/app.js                 map, filtering, stats, persistence
src/stations.js            GENERATED station data — do not edit by hand
data/stations.txt          the actual station data, pipe-delimited
scripts/build_stations.py  data/stations.txt  ->  src/stations.js
```

`src/stations.js` is committed so the page works with no build step. Regenerate it after editing
the data:

```bash
python3 scripts/build_stations.py
```

## Where the data comes from

[MTA Subway Stations](https://data.ny.gov/d/39hk-dx4f) on NY State Open Data, grouped by
`complex_id` so that connected stations become a single stop. Each row is
`id|name|borough|routes|lat|lon|ada`; boroughs are `M`, `Bk`, `Q`, `Bx`, `SI`.

Coordinates for a complex are the average of its constituent platforms, so a marker sits over the
middle of the complex rather than over one particular entrance.

## Deploying

It's a static site, so GitHub Pages works with no configuration: **Settings → Pages → Deploy from a
branch → `main` / `/ (root)`**.

## License

MIT
