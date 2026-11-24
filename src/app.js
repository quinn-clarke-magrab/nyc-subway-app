/* NYC Subway Tracker
 * Stations come from src/stations.js (window.STATIONS), generated from
 * data/stations.txt. Ticks live in localStorage — nothing leaves the browser.
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'nyc-subway-tracker.v1';

  // The wall map leaves the Staten Island Railway off. Flip this to true to put
  // the island, its 21 stops and the SIR line back on the map.
  var INCLUDE_STATEN_ISLAND = false;

  var STATIONS = (window.STATIONS || []).filter(function (s) {
    return INCLUDE_STATEN_ISLAND || s.borough !== 'SI';
  });

  // Official-ish MTA route colors. `dark` marks bullets that need black text.
  var ROUTE_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C',
    '7': '#B933AD',
    A: '#0039A6', C: '#0039A6', E: '#0039A6',
    B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
    G: '#6CBE45',
    J: '#996633', Z: '#996633',
    L: '#A7A9AC',
    N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
    S: '#808183',
    SIR: '#0039A6',
  };
  var DARK_TEXT = { N: 1, Q: 1, R: 1, W: 1, L: 1 };

  // Display order for filters and the per-line breakdown.
  var ROUTE_ORDER = [
    '1', '2', '3', '4', '5', '6', '7',
    'A', 'C', 'E', 'B', 'D', 'F', 'M',
    'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SIR',
  ];

  var BOROUGHS = [
    { code: 'M', name: 'Manhattan' },
    { code: 'Bk', name: 'Brooklyn' },
    { code: 'Q', name: 'Queens' },
    { code: 'Bx', name: 'Bronx' },
    { code: 'SI', name: 'Staten Island' },
  ].filter(function (b) {
    return INCLUDE_STATEN_ISLAND || b.code !== 'SI';
  });
  var BOROUGH_NAME = {};
  BOROUGHS.forEach(function (b) {
    BOROUGH_NAME[b.code] = b.name;
  });

  // ---------- state ----------

  var visited = loadVisited(); // id -> ISO timestamp
  var filters = {
    query: '',
    routes: new Set(), // empty = no line filter
    boroughs: new Set(), // empty = all boroughs
    status: 'all', // all | visited | todo
  };
  var activeId = null;
  var markers = new Map(); // station id -> Leaflet CircleMarker
  var rowsById = new Map(); // station id -> <li>

  STATIONS.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  function loadVisited() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.visited === 'object' && parsed.visited !== null
        ? parsed.visited
        : {};
    } catch (err) {
      console.warn('Could not read saved progress:', err);
      return {};
    }
  }

  function saveVisited() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, savedAt: new Date().toISOString(), visited: visited }),
      );
    } catch (err) {
      toast("Couldn't save — browser storage is blocked");
      console.warn(err);
    }
  }

  function isVisited(station) {
    return Object.prototype.hasOwnProperty.call(visited, station.id);
  }

  // ---------- small helpers ----------

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function routeColor(route) {
    return ROUTE_COLORS[route] || '#6b7688';
  }

  function bulletEl(route, cls) {
    var b = el('span', (cls || 'bullet') + (route.length > 1 ? ' wide' : ''), route);
    b.style.background = routeColor(route);
    b.style.color = DARK_TEXT[route] ? '#101010' : '#fff';
    return b;
  }

  function bulletsEl(routes) {
    var wrap = el('span', 'bullets');
    routes.forEach(function (r) {
      wrap.appendChild(bulletEl(r));
    });
    return wrap;
  }

  var toastTimer;
  function toast(message) {
    var node = $('#toast');
    node.textContent = message;
    node.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove('is-on');
    }, 2200);
  }

  function pct(done, total) {
    return total ? Math.round((done / total) * 100) : 0;
  }

  // ---------- map ----------

  // The wall map takes two liberties with geography: it turns the city so
  // Manhattan reads straight up the page, and it draws the dense middle larger
  // than scale so it stays legible while the outer boroughs tighten up. Both
  // happen here, to the coordinates rather than to the rendered map — rotating
  // or scaling the rendering would put clicks out of step with what's drawn.
  // Leaflet runs on CRS.Simple and never sees a real latitude; the station data
  // stays honest lat/lon.
  var ROTATION_DEG = 23; // Manhattan's long axis sits ~23° east of north
  var PIVOT = { lat: 40.75, lon: -73.95 };
  var SCALE = 3000; // plane units per degree of latitude at zoom 0

  // Magnification, strongest at the origin and easing off with distance.
  // 0 gives true proportions; much past 1 and the outer boroughs look squashed.
  var FISHEYE = 0.8;
  var FISHEYE_ORIGIN = { lat: 40.758, lon: -73.979 }; // Midtown

  var ROT = (ROTATION_DEG * Math.PI) / 180;
  var COS_R = Math.cos(ROT);
  var SIN_R = Math.sin(ROT);
  var LON_SQUEEZE = Math.cos((PIVOT.lat * Math.PI) / 180);

  // lat/lon -> flat rotated plane, before magnification. Returns [east, north].
  function plane(lat, lon) {
    var x = (lon - PIVOT.lon) * LON_SQUEEZE * SCALE;
    var y = (lat - PIVOT.lat) * SCALE;
    return [x * COS_R - y * SIN_R, x * SIN_R + y * COS_R];
  }

  var ORIGIN_XY = plane(FISHEYE_ORIGIN.lat, FISHEYE_ORIGIN.lon);
  var FISHEYE_SPAN = 1; // set by measureSpan() once all the geometry is decoded

  // Distance d from the origin becomes d(1+k) / (1 + k·d/span). Smooth, never
  // folds back on itself, and leaves the outermost point exactly where it was,
  // so magnifying the middle can't push the edges off the map.
  function magnify(xy) {
    if (!FISHEYE) return xy;
    var dx = xy[0] - ORIGIN_XY[0];
    var dy = xy[1] - ORIGIN_XY[1];
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9) return xy;
    var u = d / FISHEYE_SPAN;
    var factor = ((u * (1 + FISHEYE)) / (1 + FISHEYE * u)) * (FISHEYE_SPAN / d);
    return [ORIGIN_XY[0] + dx * factor, ORIGIN_XY[1] + dy * factor];
  }

  // CRS.Simple reads a LatLng as (northing, easting).
  function project(lat, lon) {
    var xy = magnify(plane(lat, lon));
    return L.latLng(xy[1], xy[0]);
  }

  function projectPath(points) {
    return points.map(function (p) {
      return project(p[0], p[1]);
    });
  }

  // The transform needs the size of the whole drawing up front, or the far
  // corners get pulled inward and clipped.
  function measureSpan(pointSets) {
    var furthest = 0;
    pointSets.forEach(function (points) {
      points.forEach(function (p) {
        var xy = plane(p[0], p[1]);
        var dx = xy[0] - ORIGIN_XY[0];
        var dy = xy[1] - ORIGIN_XY[1];
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > furthest) furthest = d;
      });
    });
    FISHEYE_SPAN = furthest || 1;
  }

  var map = L.map('map', {
    crs: L.CRS.Simple,
    zoomControl: true,
    preferCanvas: true,
    // -1 fits the whole system on a desktop pane; a phone needs to go further
    // out than that, and fitAll was landing exactly on the old -2 floor.
    minZoom: -3,
    maxZoom: 4,
    // Leaflet drives its zoom animation off the proxy element a tile layer
    // creates. There are no tiles here, so the first animated zoom never
    // finishes and every zoom after it is silently dropped — the +/- buttons
    // and the scroll wheel stop working. Turning the animation off is the fix;
    // with nothing to fade there is nothing to miss.
    zoomAnimation: false,
    markerZoomAnimation: false,
    // A wheel notch moving a whole zoom level is a lurch on a map this small.
    // Quarter-level steps and a longer wheel throw make it feel continuous.
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 220,
    wheelDebounceTime: 30,
    // Arbitrary: fitBounds sets the real view once the geometry is measured.
  }).setView([0, 0], 0);

  L.control
    .attribution({ prefix: false })
    .addAttribution('Stations, routes & shoreline: MTA / NY State &amp; NYC Open Data')
    .addTo(map);

  // Stacked panes so drawing order is fixed regardless of load order: shoreline,
  // then borough names sitting in the background like the wall map, then routes,
  // then station ticks on top.
  var PANES = [
    ['landPane', 350],
    ['parkPane', 355],
    ['labelPane', 360],
    ['routePane', 380],
    ['stationPane', 450],
    ['stationLabelPane', 460],
  ];
  // A fingertip is about 40px across and a station tick is a few pixels, so on
  // touch screens the canvas counts a tap as hitting the nearest stop within
  // this many pixels. Without it you have to pinch right in before anything is
  // tappable at all.
  var TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var HIT_TOLERANCE = TOUCH ? 14 : 3;

  var renderers = {};
  PANES.forEach(function (entry) {
    map.createPane(entry[0]).style.zIndex = String(entry[1]);
    renderers[entry[0]] = L.canvas({
      pane: entry[0],
      tolerance: entry[0] === 'stationPane' ? HIT_TOLERANCE : 0,
    });
  });

  // Reverses the delta encoding in src/geo.js: signed zig-zag varints, 5 bits
  // per character, at 1e-5 degrees. Mirrors the encoder in scripts/build_geo.py.
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';
  var ALPHA_INDEX = {};
  for (var ai = 0; ai < ALPHA.length; ai++) ALPHA_INDEX[ALPHA[ai]] = ai;

  function decodePath(encoded) {
    var points = [];
    var i = 0;
    var lat = 0;
    var lng = 0;

    function next() {
      var result = 0;
      var shift = 0;
      var chunk;
      do {
        chunk = ALPHA_INDEX[encoded[i++]];
        result |= (chunk & 0x1f) << shift;
        shift += 5;
      } while (chunk >= 0x20);
      return result & 1 ? ~(result >> 1) : result >> 1;
    }

    while (i < encoded.length) {
      lat += next();
      lng += next();
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  var GEO = window.SUBWAY_GEO || { routes: {}, land: [] };

  // Each key is one color on the MTA map, not one service — the 1/2/3 share a
  // red trunk the same way they do on the wall map.
  var MAP_COLORS = {
    red: '#EE352E',
    green: '#00933C',
    purple: '#B933AD',
    blue: '#0039A6',
    orange: '#FF6319',
    lime: '#6CBE45',
    brown: '#996633',
    grey: '#A7A9AC',
    yellow: '#FCCC0A',
    slate: '#808183',
    sir: '#0039A6',
  };

  // The wall map draws its big parks in green. Corners are the real ones, so
  // the shape lands correctly once rotation and magnification are applied.
  var PARKS = [
    {
      name: 'Central Park',
      ring: [
        [40.768, -73.9819], // 59 St & Central Park West
        [40.7644, -73.973], // 59 St & 5 Av
        [40.7969, -73.9497], // 110 St & 5 Av
        [40.8007, -73.9582], // 110 St & Central Park West
      ],
    },
  ];

  // Anything west of this belongs to Staten Island, which the map leaves out.
  function isStatenIsland(points) {
    var lon = 0;
    points.forEach(function (p) {
      lon += p[1];
    });
    return lon / points.length < -74.05;
  }

  var landRings = (GEO.land || []).map(decodePath).filter(function (ring) {
    return INCLUDE_STATEN_ISLAND || !isStatenIsland(ring);
  });

  var routeLines = [];
  Object.keys(GEO.routes || {}).forEach(function (colorKey) {
    if (!INCLUDE_STATEN_ISLAND && colorKey === 'sir') return;
    var color = MAP_COLORS[colorKey] || '#6b7688';
    GEO.routes[colorKey].forEach(function (encoded) {
      routeLines.push({ color: color, points: decodePath(encoded) });
    });
  });

  // Everything that will be drawn, so the magnification knows its outer limit.
  measureSpan(
    [
      STATIONS.map(function (s) {
        return [s.lat, s.lon];
      }),
    ]
      .concat(landRings)
      .concat(
        routeLines.map(function (line) {
          return line.points;
        }),
      ),
  );

  landRings.forEach(function (ring) {
    L.polygon(projectPath(ring), {
      pane: 'landPane',
      renderer: renderers.landPane,
      color: '#d9d5c9',
      weight: 1,
      fillColor: '#fbf9f2',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  });

  PARKS.forEach(function (park) {
    L.polygon(projectPath(park.ring), {
      pane: 'parkPane',
      renderer: renderers.parkPane,
      color: '#9ac98a',
      weight: 1,
      fillColor: '#bcdfae',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  });

  routeLines.forEach(function (line) {
    L.polyline(projectPath(line.points), {
      pane: 'routePane',
      renderer: renderers.routePane,
      color: line.color,
      weight: 5,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(map);
  });

  // Borough names set into the background, the way they are on the wall map.
  // Placed in open space rather than at true centroids, so they don't sit on
  // top of the lines.
  [
    ['The Bronx', 40.883, -73.845],
    ['Manhattan', 40.812, -74.005],
    ['Queens', 40.733, -73.772],
    ['Brooklyn', 40.617, -73.932],
  ].forEach(function (entry) {
    L.marker(project(entry[1], entry[2]), {
      pane: 'labelPane',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: 'boro-label', html: entry[0], iconSize: null }),
    }).addTo(map);
  });

  var markerLayer = L.layerGroup().addTo(map);

  // Zoomed out, the whole system is on screen and fat dots would bury the route
  // lines; zoomed in there's room for proper targets. So size follows zoom.
  // With the whole system on screen, neighbouring stops are only a few pixels
  // apart and fat ticks would merge into one white smear over the lines. Size
  // follows how far apart a typical pair of stops currently is on screen.
  var TYPICAL_GAP_DEG = 0.005;

  function baseRadius() {
    var gapPx = TYPICAL_GAP_DEG * SCALE * Math.pow(2, map.getZoom());
    // Floor is higher on touch so a stop is still something you can see and aim
    // at on a phone, where the whole system is squeezed into a few hundred px.
    return Math.max(TOUCH ? 2.6 : 1.5, Math.min(9, gapPx * 0.32));
  }

  // Station ticks follow the wall map: a hollow white circle with a dark ring,
  // filled in solid once you've been there. Deliberately ink rather than the
  // line's own color — a filled stop on the grey L or the yellow N/Q/R/W would
  // otherwise disappear into the line underneath it.
  function markerStyle(station) {
    var r = baseRadius();
    return {
      radius: r,
      color: '#1d2430',
      weight: Math.max(0.8, r * 0.3),
      opacity: 1,
      fillColor: isVisited(station) ? '#1d2430' : '#ffffff',
      fillOpacity: 1,
    };
  }

  map.on('zoomend', function () {
    STATIONS.forEach(function (station) {
      var marker = markers.get(station.id);
      if (marker) marker.setStyle(markerStyle(station));
    });
  });

  function tooltipHtml(station) {
    var wrap = el('div');
    wrap.appendChild(el('div', 'tip-name', station.name));
    wrap.appendChild(
      el(
        'div',
        'tip-sub',
        BOROUGH_NAME[station.borough] + (isVisited(station) ? ' · been there' : ''),
      ),
    );
    wrap.appendChild(bulletsEl(station.routes));
    return wrap;
  }

  STATIONS.forEach(function (station) {
    var options = markerStyle(station);
    options.pane = 'stationPane';
    options.renderer = renderers.stationPane;
    var marker = L.circleMarker(project(station.lat, station.lon), options);
    marker.bindTooltip(tooltipHtml(station), {
      className: 'stop-tip',
      direction: 'top',
      offset: [0, -8],
    });
    marker.on('click', function () {
      toggle(station);
      setActive(station.id, false);
    });
    markers.set(station.id, marker);
  });

  function refreshMarker(station) {
    var marker = markers.get(station.id);
    if (!marker) return;
    marker.setStyle(markerStyle(station));
    marker.setTooltipContent(tooltipHtml(station));
  }

  // ---------- station labels ----------

  // 424 names will not fit on screen at once, so the map draws as many as it
  // can without them touching: biggest interchanges first, each one tried to
  // the right of its tick, then left, above, below. Anything with nowhere to go
  // is left off until you zoom in and room opens up.
  var labelHost = L.DomUtil.create('div', 'station-labels', map.getPane('stationLabelPane'));
  // Smaller on a phone, where the whole system is a few hundred pixels wide and
  // desktop-sized names would crowd each other out. The host carries the font
  // so the measuring canvas and the rendered label can never drift apart.
  var LABEL_SIZE = TOUCH ? 9.5 : 10.5;
  var LABEL_FONT =
    '600 ' + LABEL_SIZE + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial';
  var LABEL_HEIGHT = Math.round(LABEL_SIZE + 2);
  labelHost.style.font = LABEL_FONT;
  var LABEL_PAD = 3;
  var measureCtx = document.createElement('canvas').getContext('2d');
  var widthCache = {};

  function textWidth(text) {
    if (widthCache[text] === undefined) {
      measureCtx.font = LABEL_FONT;
      widthCache[text] = measureCtx.measureText(text).width;
    }
    return widthCache[text];
  }

  // "Times Sq-42 St / 42 St-Port Authority Bus Terminal" -> "Times Sq-42 St".
  // The data already uses the MTA's own abbreviations (Av, St, Sq, Blvd), so
  // there's little left to shorten beyond dropping the second half of a
  // complex's name and any parenthetical.
  var shortNames = {};
  function shortName(station) {
    if (shortNames[station.id] === undefined) {
      var s = station.name.split(' / ')[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (s.length > 22) s = s.slice(0, 21).replace(/[\s-]+$/, '') + '…';
      shortNames[station.id] = s;
    }
    return shortNames[station.id];
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function renderLabels() {
    labelHost.textContent = '';

    var bounds = map.getBounds().pad(0.05);
    var r = baseRadius();
    var visible = [];
    markers.forEach(function (marker, id) {
      if (!markerLayer.hasLayer(marker)) return;
      if (!bounds.contains(marker.getLatLng())) return;
      visible.push(id);
    });

    // Interchanges earn their label first; ties broken by id so the set is
    // stable as you pan rather than flickering between equals.
    var byId = {};
    STATIONS.forEach(function (s) {
      byId[s.id] = s;
    });
    visible.sort(function (a, b) {
      return byId[b].routes.length - byId[a].routes.length || a - b;
    });

    // Every tick in view is an obstacle, not just the ones that get a label.
    var taken = visible.map(function (id) {
      var p = map.latLngToLayerPoint(markers.get(id).getLatLng());
      return { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 };
    });

    // A name sliced in half by the edge of the map is worse than no name, so a
    // placement has to fit inside the viewport as well as miss everything else.
    var topLeft = map.containerPointToLayerPoint([0, 0]);
    var size = map.getSize();
    var viewport = { x: topLeft.x + 2, y: topLeft.y + 2, w: size.x - 4, h: size.y - 4 };

    function insideView(rect) {
      return (
        rect.x >= viewport.x &&
        rect.y >= viewport.y &&
        rect.x + rect.w <= viewport.x + viewport.w &&
        rect.y + rect.h <= viewport.y + viewport.h
      );
    }

    var frag = document.createDocumentFragment();
    var gap = r + 3;

    visible.forEach(function (id) {
      var station = byId[id];
      var text = shortName(station);
      var w = textWidth(text);
      var p = map.latLngToLayerPoint(markers.get(id).getLatLng());

      var candidates = [
        { x: p.x + gap, y: p.y - LABEL_HEIGHT / 2 },
        { x: p.x - gap - w, y: p.y - LABEL_HEIGHT / 2 },
        { x: p.x - w / 2, y: p.y - gap - LABEL_HEIGHT },
        { x: p.x - w / 2, y: p.y + gap },
      ];

      for (var i = 0; i < candidates.length; i++) {
        var rect = {
          x: candidates[i].x - LABEL_PAD,
          y: candidates[i].y - LABEL_PAD,
          w: w + LABEL_PAD * 2,
          h: LABEL_HEIGHT + LABEL_PAD * 2,
        };
        if (!insideView(rect)) continue;
        var clear = true;
        for (var j = 0; j < taken.length; j++) {
          if (overlaps(rect, taken[j])) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;

        var node = el('span', 'stop-label' + (isVisited(station) ? ' is-visited' : ''), text);
        node.style.left = candidates[i].x + 'px';
        node.style.top = candidates[i].y + 'px';
        frag.appendChild(node);
        taken.push(rect);
        return;
      }
    });

    labelHost.appendChild(frag);
  }

  map.on('moveend zoomend', renderLabels);

  // The map sits in a flex layout, so its box can settle well after Leaflet has
  // measured it and after any window resize event — an embedded browser pane
  // opening at one size and reflowing to another never fires one. Watching the
  // element itself catches every case. Until you move the map yourself, the
  // view is re-fitted too, so a late reflow doesn't leave it framed for a size
  // the map no longer is.
  var userMoved = false;

  function noteUserMoved() {
    userMoved = true;
  }

  ['pointerdown', 'wheel', 'keydown'].forEach(function (type) {
    map.getContainer().addEventListener(type, noteUserMoved, { passive: true });
  });

  var NARROW = window.matchMedia('(max-width: 860px)');

  function fitAll() {
    // On a phone the floating bar sits over the top of the map and the
    // attribution over the bottom, so the city is inset past both.
    var top = NARROW.matches ? 54 : 14;
    var bottom = NARROW.matches ? 30 : 14;
    map.fitBounds(
      L.latLngBounds(
        STATIONS.map(function (s) {
          return project(s.lat, s.lon);
        }),
      ),
      { paddingTopLeft: L.point(14, top), paddingBottomRight: L.point(14, bottom) },
    );
  }

  function remeasure() {
    var box = map.getContainer();
    // Zero while the list is covering it; measuring then would corrupt the view.
    if (!box.offsetWidth || !box.offsetHeight) return;
    map.invalidateSize();
    if (!userMoved) fitAll();
    renderLabels();
  }

  if (window.ResizeObserver) {
    new ResizeObserver(remeasure).observe(map.getContainer());
  } else {
    window.addEventListener('resize', remeasure);
  }

  // ---------- phone map/list switch ----------

  var viewToggle = $('#view-toggle');

  function setListView(showList) {
    document.body.classList.toggle('show-list', showList);
    viewToggle.textContent = showList ? 'Map' : 'List';
    viewToggle.setAttribute('aria-pressed', String(showList));
    if (!showList) remeasure();
  }

  viewToggle.addEventListener('click', function () {
    setListView(!document.body.classList.contains('show-list'));
  });

  function showMapIfListCovering() {
    if (document.body.classList.contains('show-list')) setListView(false);
  }

  // ---------- toggling ----------

  function toggle(station) {
    if (isVisited(station)) {
      delete visited[station.id];
    } else {
      visited[station.id] = new Date().toISOString();
    }
    saveVisited();
    refreshMarker(station);
    updateRow(station);
    renderProgress();
    renderStats();

    // A station can drop out of the current view once its status flips.
    if (filters.status !== 'all') renderList();
    else renderLabels();
  }

  function setActive(id, pan) {
    activeId = id;
    rowsById.forEach(function (row, rowId) {
      row.classList.toggle('is-active', rowId === id);
    });
    var row = rowsById.get(id);
    if (row) row.scrollIntoView({ block: 'nearest' });

    var station = STATIONS.find(function (s) {
      return s.id === id;
    });
    if (pan && station) {
      // On a phone the list is covering the map, and panning something you
      // can't see is no use — so show it.
      showMapIfListCovering();
      userMoved = true;
      map.setView(project(station.lat, station.lon), Math.max(map.getZoom(), 2), { animate: true });
      var marker = markers.get(id);
      if (marker) marker.openTooltip();
    }
  }

  // ---------- filtering ----------

  function matches(station) {
    if (filters.status === 'visited' && !isVisited(station)) return false;
    if (filters.status === 'todo' && isVisited(station)) return false;
    if (filters.boroughs.size && !filters.boroughs.has(station.borough)) return false;
    if (filters.routes.size) {
      var hit = station.routes.some(function (r) {
        return filters.routes.has(r);
      });
      if (!hit) return false;
    }
    if (filters.query) {
      var haystack = (station.name + ' ' + station.routes.join(' ')).toLowerCase();
      if (haystack.indexOf(filters.query) === -1) return false;
    }
    return true;
  }

  function visibleStations() {
    return STATIONS.filter(matches);
  }

  // What you've narrowed to, ignoring the been-there/not-yet switch: picking
  // "Not yet" shouldn't make Brooklyn's total shrink to the stops you've missed.
  function scopeStations() {
    var saved = filters.status;
    filters.status = 'all';
    var set = STATIONS.filter(matches);
    filters.status = saved;
    return set;
  }

  function scopeLabel() {
    var parts = [];
    if (filters.boroughs.size) {
      parts.push(
        BOROUGHS.filter(function (b) {
          return filters.boroughs.has(b.code);
        })
          .map(function (b) {
            return b.name;
          })
          .join(' + '),
      );
    }
    if (filters.routes.size) {
      parts.push(
        ROUTE_ORDER.filter(function (r) {
          return filters.routes.has(r);
        }).join('/') + (filters.routes.size > 1 ? ' lines' : ' line'),
      );
    }
    if (filters.query) parts.push('“' + filters.query + '”');
    return parts.join(' · ');
  }

  // ---------- rendering ----------

  function buildRow(station) {
    var li = el('li', 'station');
    li.dataset.id = String(station.id);

    var tick = el('span', 'tick', '✓');
    var main = el('span', 'station-main');
    main.appendChild(el('span', 'station-name', station.name));
    main.appendChild(el('span', 'station-sub', BOROUGH_NAME[station.borough]));

    li.appendChild(tick);
    li.appendChild(main);
    li.appendChild(bulletsEl(station.routes));

    li.addEventListener('click', function (event) {
      // Clicking the checkbox ticks it; clicking the row flies to it on the map.
      if (event.target.closest('.tick')) {
        toggle(station);
      } else {
        setActive(station.id, true);
      }
    });

    return li;
  }

  function updateRow(station) {
    var row = rowsById.get(station.id);
    if (row) row.classList.toggle('is-visited', isVisited(station));
  }

  function renderList() {
    var list = $('#station-list');
    var shown = visibleStations();

    list.textContent = '';
    rowsById.clear();

    if (!shown.length) {
      var empty = el('li', 'empty', 'No stops match those filters.');
      list.appendChild(empty);
    } else {
      var frag = document.createDocumentFragment();
      shown.forEach(function (station) {
        var row = buildRow(station);
        row.classList.toggle('is-visited', isVisited(station));
        row.classList.toggle('is-active', station.id === activeId);
        rowsById.set(station.id, row);
        frag.appendChild(row);
      });
      list.appendChild(frag);
    }

    var done = shown.filter(isVisited).length;
    $('#list-meta').textContent =
      shown.length === STATIONS.length
        ? shown.length + ' stops'
        : shown.length + ' of ' + STATIONS.length + ' stops · ' + done + ' ticked';

    // Only keep matching markers on the map.
    markerLayer.clearLayers();
    shown.forEach(function (station) {
      markerLayer.addLayer(markers.get(station.id));
    });
    renderLabels();
    renderScope();
  }

  function renderProgress() {
    var done = STATIONS.filter(isVisited).length;
    var percent = pct(done, STATIONS.length);
    $('#visited-count').textContent = done;
    $('#total-count').textContent = STATIONS.length;
    $('#visited-pct').textContent = percent + '%';
    $('#overall-bar').style.width = percent + '%';

    // Mirrored into the bar that floats over the full-screen map on a phone.
    $('#m-count').textContent = done;
    $('#m-total').textContent = STATIONS.length;
    $('#m-pct').textContent = percent + '%';

    var note = $('#progress-note');
    if (!done) {
      note.textContent = 'Tap a dot on the map, or a checkbox in the list.';
    } else if (done === STATIONS.length) {
      note.textContent = 'Every stop in the system. Genuinely remarkable.';
    } else {
      note.textContent = STATIONS.length - done + ' to go.';
    }

    renderScope();
  }

  // Tapping a borough (or a line) answers "how am I doing there?" right under
  // the overall number, rather than making you go and read the Breakdown tab.
  function renderScope() {
    var box = $('#scope-note');
    var label = scopeLabel();
    if (!label) {
      box.classList.add('is-hidden');
      return;
    }

    var set = scopeStations();
    var done = set.filter(isVisited).length;
    var percent = pct(done, set.length);

    box.classList.remove('is-hidden');
    box.textContent = '';
    box.appendChild(el('span', 'scope-name', label));
    box.appendChild(el('span', 'scope-count', done + '/' + set.length));
    box.appendChild(el('span', 'scope-pct', percent + '%'));
    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    fill.style.width = percent + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
  }

  // `detailed` rows get a spelled-out name and a percentage; the line rows stay
  // compact because a route bullet needs no room and there are 23 of them.
  function statRow(label, labelNode, done, total, detailed) {
    var row = el('div', 'stat-row' + (detailed ? ' is-detailed' : ''));
    row.appendChild(labelNode || el('span', 'stat-label', label));

    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    fill.style.width = pct(done, total) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);

    row.appendChild(el('span', 'count', done + '/' + total));
    if (detailed) row.appendChild(el('span', 'stat-pct', pct(done, total) + '%'));
    return row;
  }

  function renderStats() {
    var lineBox = $('#line-stats');
    lineBox.textContent = '';
    ROUTE_ORDER.forEach(function (route) {
      var onLine = STATIONS.filter(function (s) {
        return s.routes.indexOf(route) !== -1;
      });
      if (!onLine.length) return;
      var done = onLine.filter(isVisited).length;
      lineBox.appendChild(statRow(route, bulletEl(route), done, onLine.length));
    });

    var boroughBox = $('#borough-stats');
    boroughBox.textContent = '';
    BOROUGHS.forEach(function (b) {
      var inBorough = STATIONS.filter(function (s) {
        return s.borough === b.code;
      });
      if (!inBorough.length) return;
      var done = inBorough.filter(isVisited).length;
      boroughBox.appendChild(statRow(b.name, null, done, inBorough.length, true));
    });
  }

  // ---------- filter UI ----------

  function buildFilterUI() {
    var lineBox = $('#line-filters');
    ROUTE_ORDER.forEach(function (route) {
      var inUse = STATIONS.some(function (s) {
        return s.routes.indexOf(route) !== -1;
      });
      if (!inUse) return;

      var pill = bulletEl(route, 'pill');
      pill.title = route + ' line';
      pill.addEventListener('click', function () {
        if (filters.routes.has(route)) filters.routes.delete(route);
        else filters.routes.add(route);
        pill.classList.toggle('is-on', filters.routes.has(route));
        renderList();
      });
      lineBox.appendChild(pill);
    });

    var boroughBox = $('#borough-filters');
    BOROUGHS.forEach(function (b) {
      var chip = el('button', 'chip', b.name);
      chip.addEventListener('click', function () {
        if (filters.boroughs.has(b.code)) filters.boroughs.delete(b.code);
        else filters.boroughs.add(b.code);
        chip.classList.toggle('is-on', filters.boroughs.has(b.code));
        renderList();
      });
      boroughBox.appendChild(chip);
    });

    $('#status-filters').addEventListener('click', function (event) {
      var btn = event.target.closest('.chip');
      if (!btn) return;
      filters.status = btn.dataset.status;
      Array.prototype.forEach.call($('#status-filters').children, function (c) {
        c.classList.toggle('is-on', c === btn);
      });
      renderList();
    });

    $('#search').addEventListener('input', function (event) {
      filters.query = event.target.value.trim().toLowerCase();
      renderList();
    });

    $('#tabs').addEventListener('click', function (event) {
      var tab = event.target.closest('.tab');
      if (!tab) return;
      Array.prototype.forEach.call($('#tabs').children, function (t) {
        t.classList.toggle('is-on', t === tab);
      });
      $('#panel-list').classList.toggle('is-hidden', tab.dataset.tab !== 'list');
      $('#panel-stats').classList.toggle('is-hidden', tab.dataset.tab !== 'stats');
    });
  }

  // ---------- footer actions ----------

  function buildFooterActions() {
    $('#random').addEventListener('click', function () {
      var todo = STATIONS.filter(function (s) {
        return !isVisited(s);
      });
      if (!todo.length) {
        toast("You've been everywhere.");
        return;
      }
      var pick = todo[Math.floor(Math.random() * todo.length)];
      setActive(pick.id, true);
      toast('Try ' + pick.name + ' (' + BOROUGH_NAME[pick.borough] + ')');
    });

    $('#export').addEventListener('click', function () {
      var payload = {
        app: 'nyc-subway-tracker',
        version: 1,
        exportedAt: new Date().toISOString(),
        visited: visited,
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = el('a');
      a.href = url;
      a.download = 'subway-stops-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    $('#import').addEventListener('click', function () {
      $('#import-file').click();
    });

    $('#import-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result));
          var incoming = parsed && parsed.visited;
          if (!incoming || typeof incoming !== 'object') throw new Error('no "visited" object');

          var known = new Set(
            STATIONS.map(function (s) {
              return String(s.id);
            }),
          );
          var added = 0;
          Object.keys(incoming).forEach(function (id) {
            if (!known.has(String(id))) return;
            if (!Object.prototype.hasOwnProperty.call(visited, id)) added++;
            visited[id] = typeof incoming[id] === 'string' ? incoming[id] : new Date().toISOString();
          });

          saveVisited();
          STATIONS.forEach(refreshMarker);
          renderProgress();
          renderStats();
          renderList();
          toast('Imported — ' + added + ' new stop' + (added === 1 ? '' : 's'));
        } catch (err) {
          toast("That file didn't look like an export");
          console.warn(err);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    });

    $('#reset').addEventListener('click', function () {
      var done = STATIONS.filter(isVisited).length;
      if (!done) {
        toast('Nothing to reset');
        return;
      }
      if (!confirm('Clear all ' + done + ' ticked stops? This cannot be undone.')) return;
      visited = {};
      saveVisited();
      STATIONS.forEach(refreshMarker);
      renderProgress();
      renderStats();
      renderList();
      toast('Cleared');
    });
  }

  // ---------- keyboard ----------

  document.addEventListener('keydown', function (event) {
    var typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('#search').focus();
      $('#search').select();
    } else if (event.key === 'Escape' && typing) {
      $('#search').value = '';
      filters.query = '';
      $('#search').blur();
      renderList();
    }
  });

  // ---------- go ----------

  if (!STATIONS.length) {
    $('#station-list').appendChild(
      el('li', 'empty', 'No station data. Run: python3 scripts/build_stations.py'),
    );
    return;
  }

  buildFilterUI();
  buildFooterActions();
  renderProgress();
  renderStats();
  renderList();

  fitAll();
})();
