/* NYC Subway Tracker
 * Stations come from src/stations.js (window.STATIONS), generated from
 * data/stations.txt. Ticks live in localStorage — nothing leaves the browser.
 */

(function () {
  'use strict';

  var STORAGE_KEY = 'nyc-subway-tracker.v1';
  var STATIONS = (window.STATIONS || []).slice();

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
  ];
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

  var map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([40.73, -73.95], 11);

  // Plain OSM tiles (no API key needed); the dark look comes from a CSS filter
  // on .leaflet-tile-pane, so there's nothing to sign up for or pay for.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ' +
      'stations: MTA / NY Open Data',
    maxZoom: 19,
  }).addTo(map);

  var markerLayer = L.layerGroup().addTo(map);

  function markerStyle(station) {
    var color = routeColor(station.routes[0]);
    var done = isVisited(station);
    return {
      radius: done ? 6 : 5,
      color: done ? '#ffffff' : color,
      weight: done ? 1.5 : 2,
      opacity: 1,
      fillColor: done ? color : '#0c0f14',
      fillOpacity: done ? 1 : 0.9,
    };
  }

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
    var marker = L.circleMarker([station.lat, station.lon], markerStyle(station));
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
      map.setView([station.lat, station.lon], Math.max(map.getZoom(), 14), { animate: true });
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
  }

  function renderProgress() {
    var done = STATIONS.filter(isVisited).length;
    var percent = pct(done, STATIONS.length);
    $('#visited-count').textContent = done;
    $('#total-count').textContent = STATIONS.length;
    $('#visited-pct').textContent = percent + '%';
    $('#overall-bar').style.width = percent + '%';

    var note = $('#progress-note');
    if (!done) {
      note.textContent = 'Click a dot on the map, or a checkbox in the list.';
    } else if (done === STATIONS.length) {
      note.textContent = 'Every stop in the system. Genuinely remarkable.';
    } else {
      note.textContent = STATIONS.length - done + ' to go.';
    }
  }

  function statRow(label, labelNode, done, total) {
    var row = el('div', 'stat-row');
    row.appendChild(labelNode || el('span', 'stat-label', label));

    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    fill.style.width = pct(done, total) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);

    row.appendChild(el('span', 'count', done + '/' + total));
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
      boroughBox.appendChild(statRow(b.name, null, done, inBorough.length));
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

  map.fitBounds(
    L.latLngBounds(
      STATIONS.map(function (s) {
        return [s.lat, s.lon];
      }),
    ),
    { padding: [30, 30] },
  );
})();
