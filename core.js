/*
 * Haze Tracker core logic. Shared by the page (app.js) and the service worker (sw.js),
 * so the same code decides when to send an alert in both places.
 */
(function (root) {
  'use strict';

  var API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
  var REGIONS = ['central', 'north', 'south', 'east', 'west'];

  // `level` (1-5) picks the colour in styles.css. Bands follow NEA's published ranges.
  var METRICS = {
    psi24: {
      id: 'psi24',
      label: '24-hr PSI',
      unit: '',
      endpoint: 'psi',
      key: 'psi_twenty_four_hourly',
      presets: [
        { label: 'Moderate', value: 51 },
        { label: 'Unhealthy', value: 101 },
        { label: 'Very unhealthy', value: 201 }
      ],
      bands: [
        { max: 50, level: 1, label: 'Good', advice: 'Normal activities.' },
        { max: 100, level: 2, label: 'Moderate', advice: 'Normal activities.' },
        { max: 200, level: 3, label: 'Unhealthy', advice: 'Reduce prolonged or strenuous outdoor activity.' },
        { max: 300, level: 4, label: 'Very unhealthy', advice: 'Avoid prolonged or strenuous outdoor activity.' },
        { max: Infinity, level: 5, label: 'Hazardous', advice: 'Minimise outdoor activity.' }
      ]
    },
    pm1h: {
      id: 'pm1h',
      label: '1-hr PM2.5',
      unit: 'µg/m³',
      endpoint: 'pm25',
      key: 'pm25_one_hourly',
      presets: [
        { label: 'Elevated', value: 56 },
        { label: 'High', value: 151 },
        { label: 'Very high', value: 251 }
      ],
      bands: [
        { max: 55, level: 1, label: 'Normal', advice: 'Normal activities.' },
        { max: 150, level: 3, label: 'Elevated', advice: 'Sensitive groups may want to take it easy outdoors.' },
        { max: 250, level: 4, label: 'High', advice: 'Reduce prolonged or strenuous outdoor activity.' },
        { max: Infinity, level: 5, label: 'Very high', advice: 'Avoid prolonged or strenuous outdoor activity.' }
      ]
    }
  };

  var DEFAULT_SETTINGS = { enabled: false, metric: 'psi24', region: 'central', threshold: 101 };

  function titleCase(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function regionLabel(region) {
    return region === 'any' ? 'Any region' : titleCase(region);
  }

  function bandFor(metricId, value) {
    var bands = METRICS[metricId].bands;
    for (var i = 0; i < bands.length; i++) {
      if (value <= bands[i].max) return bands[i];
    }
    return bands[bands.length - 1];
  }

  /** Turn an NEA response into { timestamp, updated, values: {region: number|null} }. */
  function parseReadings(json, key) {
    var items = json && json.data && json.data.items;
    if (!Array.isArray(items) || items.length === 0) throw new Error('No readings in response');
    var latest = items.reduce(function (a, b) {
      return new Date(b.timestamp) > new Date(a.timestamp) ? b : a;
    });
    var r = latest.readings && latest.readings[key];
    if (!r) throw new Error('Missing ' + key + ' in response');
    var values = {};
    REGIONS.forEach(function (region) {
      values[region] = typeof r[region] === 'number' && isFinite(r[region]) ? r[region] : null;
    });
    return { timestamp: latest.timestamp, updated: latest.updatedTimestamp || latest.timestamp, values: values };
  }

  function withTimeout(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    return undefined;
  }

  /**
   * Fetch one NEA endpoint. Tries our own /api proxy first (no CORS worries, optional API key
   * kept server-side), then NEA directly.
   */
  async function getJson(endpoint, fetchImpl) {
    var urls = ['api/' + endpoint, API_BASE + '/' + endpoint];
    var lastError;
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetchImpl(urls[i], { cache: 'no-store', signal: withTimeout(10000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (json && json.code !== undefined && json.code !== 0) throw new Error(json.errorMsg || 'API error');
        return json;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  /** Fetch both feeds independently so one failing doesn't hide the other. */
  async function getReadings(fetchImpl) {
    var ids = Object.keys(METRICS);
    var results = await Promise.allSettled(
      ids.map(function (id) {
        return getJson(METRICS[id].endpoint, fetchImpl).then(function (json) {
          return parseReadings(json, METRICS[id].key);
        });
      })
    );
    var readings = { fetchedAt: Date.now(), errors: {} };
    results.forEach(function (r, i) {
      if (r.status === 'fulfilled') readings[ids[i]] = r.value;
      else readings.errors[ids[i]] = String(r.reason && r.reason.message ? r.reason.message : r.reason);
    });
    return readings;
  }

  /** The value the alert watches: one region, or the highest region for "any". */
  function currentValue(settings, readings) {
    var m = readings && readings[settings.metric];
    if (!m) return null;
    if (settings.region === 'any') {
      var best = null;
      REGIONS.forEach(function (region) {
        var v = m.values[region];
        if (v !== null && (best === null || v > best.value)) best = { value: v, region: region };
      });
      return best && { value: best.value, region: best.region, timestamp: m.timestamp };
    }
    var value = m.values[settings.region];
    return value === null || value === undefined ? null : { value: value, region: settings.region, timestamp: m.timestamp };
  }

  /**
   * Notify when the value reaches the threshold after having been below it (or when nothing has
   * been checked yet). It stays quiet while the value remains above, and re-arms once it drops.
   */
  function checkAlert(settings, readings, prevState) {
    var current = currentValue(settings, readings);
    if (!current) return { notify: false, current: null, state: prevState || null };
    var above = current.value >= settings.threshold;
    var wasAbove = !!(prevState && prevState.above === true);
    return { notify: above && !wasAbove, current: current, state: { above: above, timestamp: current.timestamp } };
  }

  function formatTime(iso) {
    try {
      return new Intl.DateTimeFormat('en-SG', {
        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore'
      }).format(new Date(iso));
    } catch (e) {
      return '';
    }
  }

  function notificationFor(settings, current) {
    var metric = METRICS[settings.metric];
    var band = bandFor(metric.id, current.value);
    var unit = metric.unit ? ' ' + metric.unit : '';
    return {
      title: 'Haze alert: ' + regionLabel(current.region) + ' ' + metric.label + ' is ' + current.value + unit,
      body: band.label + ' (your alert is at ' + settings.threshold + unit + '). ' + band.advice +
        ' Reading from ' + formatTime(current.timestamp) + '.'
    };
  }

  // ---- tiny IndexedDB key-value store (works in both page and service worker) ----
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function kvGet(key) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function kvSet(key, value) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function loadSettings() {
    var saved = await kvGet('settings');
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
  }

  /**
   * Run one alert check. Pass `readings` if you already fetched them. Returns { readings, notified }.
   */
  async function runCheck(registration, readings) {
    readings = readings || (await getReadings(fetch.bind(root)));
    var settings = await loadSettings();
    if (!settings.enabled) return { readings: readings, notified: false };

    var prev = await kvGet('alertState');
    var result = checkAlert(settings, readings, prev);
    var notified = false;

    if (result.notify) {
      var canShow = typeof Notification !== 'undefined' && Notification.permission === 'granted';
      if (canShow) {
        var n = notificationFor(settings, result.current);
        await registration.showNotification(n.title, {
          body: n.body,
          icon: 'icons/icon-192.png',
          tag: 'haze-alert',
          renotify: true,
          data: { url: './' }
        });
        notified = true;
        await kvSet('alertState', result.state);
      }
      // If permission isn't granted yet, leave the state alone so we still alert once it is.
    } else if (result.current) {
      await kvSet('alertState', result.state);
    }
    return { readings: readings, notified: notified };
  }

  var api = {
    REGIONS: REGIONS,
    METRICS: METRICS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    regionLabel: regionLabel,
    bandFor: bandFor,
    parseReadings: parseReadings,
    getReadings: getReadings,
    currentValue: currentValue,
    checkAlert: checkAlert,
    notificationFor: notificationFor,
    formatTime: formatTime,
    kvGet: kvGet,
    kvSet: kvSet,
    loadSettings: loadSettings,
    runCheck: runCheck
  };

  root.HazeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
