(function () {
  'use strict';

  var Core = window.HazeCore;
  var $ = function (id) { return document.getElementById(id); };

  var POLL_MS = 5 * 60 * 1000; // NEA updates hourly; 5 min keeps alerts timely without hammering the API
  var CACHE_KEY = 'haze:last-readings';

  var registrationPromise = null;
  var lastFetch = 0;
  var deferredInstall = null;

  // ---------- helpers ----------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function unitOf(metricId) {
    return Core.METRICS[metricId].unit;
  }

  function sentence(settings) {
    var m = Core.METRICS[settings.metric];
    var unit = m.unit ? ' ' + m.unit : '';
    var where = settings.region === 'any' ? 'any region' : Core.regionLabel(settings.region);
    return 'Alerts are on: you\'ll be notified when the ' + m.label + ' in ' + where +
      ' reaches ' + settings.threshold + unit + ' or higher.';
  }

  function ago(ms) {
    var mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  }

  // ---------- rendering ----------
  function valueCell(metricId, value) {
    var cell = el('div', 'cell');
    if (value === null || value === undefined) {
      cell.appendChild(el('span', 'num na', '–'));
      return cell;
    }
    var band = Core.bandFor(metricId, value);
    cell.appendChild(el('span', 'num', String(value)));
    cell.appendChild(el('span', 'chip lvl-' + band.level, band.label));
    return cell;
  }

  function render(readings, settings) {
    var psi = readings.psi24;
    var pm = readings.pm1h;

    // Summary: highest 24-hr PSI across regions (falls back to 1-hr PM2.5)
    var summary = $('summary');
    var primaryId = psi ? 'psi24' : pm ? 'pm1h' : null;
    if (primaryId) {
      var data = readings[primaryId];
      var top = null;
      Core.REGIONS.forEach(function (r) {
        var v = data.values[r];
        if (v !== null && (!top || v > top.value)) top = { value: v, region: r };
      });
      if (top) {
        var band = Core.bandFor(primaryId, top.value);
        $('summary-value').textContent = String(top.value);
        $('summary-value').className = 'big lvl-' + band.level;
        $('summary-chip').textContent = band.label;
        $('summary-chip').className = 'chip lvl-' + band.level;
        $('summary-where').textContent = Core.METRICS[primaryId].label + ' · ' + Core.regionLabel(top.region) +
          ' · as of ' + Core.formatTime(data.timestamp);
        $('summary-advice').textContent = band.advice;
        summary.hidden = false;
      }
    } else {
      summary.hidden = true;
    }

    var list = $('regions');
    list.textContent = '';
    Core.REGIONS.forEach(function (region) {
      var li = el('li', 'grid');
      var name = el('div', 'name', Core.regionLabel(region));
      if (settings.enabled && (settings.region === region)) name.appendChild(el('small', '', 'Alert region'));
      li.appendChild(name);
      li.appendChild(valueCell('pm1h', pm ? pm.values[region] : null));
      li.appendChild(valueCell('psi24', psi ? psi.values[region] : null));
      list.appendChild(li);
    });
  }

  function setStatus(readings, failedLive) {
    var node = $('status');
    var ts = (readings.psi24 || readings.pm1h || {}).timestamp;
    var parts = [];
    if (ts) parts.push('Reading from ' + Core.formatTime(ts) + ' SGT');
    parts.push('checked ' + ago(Date.now() - readings.fetchedAt));
    var missing = Object.keys(readings.errors || {});
    if (failedLive) {
      node.className = 'status warn';
      node.textContent = 'Couldn\'t reach NEA, showing the last readings we saved (' + parts.join(' · ') + ').';
    } else if (missing.length) {
      node.className = 'status warn';
      node.textContent = 'Some readings are unavailable right now. ' + parts.join(' · ') + '.';
    } else {
      node.className = 'status';
      node.textContent = parts.join(' · ') + '.';
    }
  }

  // ---------- data ----------
  async function refresh() {
    var btn = $('refresh');
    btn.classList.add('spinning');
    var settings = await Core.loadSettings();
    var readings = await Core.getReadings(fetch.bind(window));
    var gotAny = !!(readings.psi24 || readings.pm1h);

    if (gotAny) {
      lastFetch = Date.now();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(readings)); } catch (e) {}
      render(readings, settings);
      setStatus(readings, false);
      try {
        var reg = await registrationPromise;
        if (reg) await Core.runCheck(reg, readings);
      } catch (e) { /* alerts are best-effort */ }
    } else {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) {}
      if (cached && (cached.psi24 || cached.pm1h)) {
        render(cached, settings);
        setStatus(cached, true);
      } else {
        $('status').className = 'status warn';
        $('status').textContent = 'Couldn\'t load readings. Check your connection and tap refresh.';
      }
    }
    btn.classList.remove('spinning');
  }

  // ---------- alert form ----------
  function updatePresets() {
    var metricId = $('metric').value;
    var m = Core.METRICS[metricId];
    $('unit').textContent = m.unit ? '(' + m.unit + ')' : '(PSI)';
    var box = $('presets');
    box.textContent = '';
    m.presets.forEach(function (p) {
      var b = el('button', '', p.label + ' · ' + p.value);
      b.type = 'button';
      b.addEventListener('click', function () { $('threshold').value = p.value; });
      box.appendChild(b);
    });
  }

  function readForm() {
    return {
      enabled: $('enabled').checked,
      metric: $('metric').value,
      region: $('region').value,
      threshold: Math.round(Number($('threshold').value))
    };
  }

  function fillForm(s) {
    $('enabled').checked = s.enabled;
    $('metric').value = s.metric;
    $('region').value = s.region;
    $('threshold').value = s.threshold;
    updatePresets();
  }

  function notificationsSupported() {
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function ensurePermission() {
    if (!notificationsSupported()) {
      return isIos() && !isStandalone()
        ? 'On iPhone, add the app to your Home Screen first (see below), then open it from there to turn on notifications.'
        : 'This browser doesn\'t support notifications.';
    }
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'denied') {
      return 'Notifications are blocked. Allow them for this app in your phone or browser settings, then save again.';
    }
    return '';
  }

  async function syncBackgroundCheck(enabled) {
    try {
      var reg = await registrationPromise;
      if (!reg || !('periodicSync' in reg)) return;
      if (enabled) await reg.periodicSync.register('haze-check', { minInterval: 60 * 60 * 1000 });
      else await reg.periodicSync.unregister('haze-check');
    } catch (e) { /* not supported or not allowed: foreground checks still work */ }
  }

  async function onSave(event) {
    event.preventDefault();
    var status = $('alert-status');
    var s = readForm();
    if (!Number.isFinite(s.threshold) || s.threshold < 1) {
      status.textContent = 'Enter a threshold of 1 or more.';
      $('threshold').focus();
      return;
    }
    var problem = s.enabled ? await ensurePermission() : '';
    await Core.kvSet('settings', s);
    await Core.kvSet('alertState', null); // re-evaluate from scratch with the new rule
    await syncBackgroundCheck(s.enabled);

    if (!s.enabled) status.textContent = 'Alerts are off.';
    else status.textContent = problem ? problem : sentence(s);
    await refresh();
  }

  async function onTest() {
    var status = $('alert-status');
    var problem = await ensurePermission();
    if (problem) { status.textContent = problem; return; }
    try {
      var reg = await registrationPromise;
      await reg.showNotification('Haze Tracker test', {
        body: 'Notifications are working on this device.',
        icon: 'icons/icon-192.png',
        tag: 'haze-test'
      });
      status.textContent = 'Test notification sent.';
    } catch (e) {
      status.textContent = 'Couldn\'t show a notification on this device.';
    }
  }

  // ---------- install ----------
  function setupInstall() {
    var card = $('install');
    if (isStandalone()) return;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      $('install-text').textContent = 'Install Haze Tracker for one-tap access and to receive alerts like any other app.';
      $('install-btn').hidden = false;
      card.hidden = false;
    });
    $('install-btn').addEventListener('click', async function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      $('install-btn').hidden = true;
    });
    window.addEventListener('appinstalled', function () { card.hidden = true; });

    if (isIos()) {
      $('install-text').textContent =
        'In Safari, tap the Share button, then "Add to Home Screen". Open the app from your Home Screen to turn on notifications.';
      card.hidden = false;
    }
  }

  // ---------- start ----------
  async function init() {
    registrationPromise = 'serviceWorker' in navigator
      ? navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; })
          .catch(function () { return null; })
      : Promise.resolve(null);

    var settings = await Core.loadSettings();
    fillForm(settings);
    if (settings.enabled) $('alert-status').textContent = sentence(settings);

    $('metric').addEventListener('change', function () {
      // Switching scale: move the threshold to that scale's first preset so it isn't nonsense.
      $('threshold').value = Core.METRICS[$('metric').value].presets[1].value;
      updatePresets();
    });
    $('alert-form').addEventListener('submit', onSave);
    $('test').addEventListener('click', onTest);
    $('refresh').addEventListener('click', refresh);
    setupInstall();

    // Show the last readings immediately while the live ones load.
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && (cached.psi24 || cached.pm1h)) render(cached, settings);
    } catch (e) {}

    refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastFetch > 2 * 60 * 1000) refresh();
    });
  }

  init();
})();
