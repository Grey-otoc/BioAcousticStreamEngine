'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

// Application version — update here when releasing. Keep in sync with pyproject.toml.
const BASE_VERSION = '1.1.0';

const DB_NAME    = 'base-viewer';
const DB_VERSION = 1;  // IndexedDB schema version — only increment on schema changes
const MAX_SOUNDS = 5;
const MAX_SIMULTANEOUS_AUDIO = 3;
const MAX_GALLERY_ENTRIES = 200;  // hard DOM cap regardless of retention setting
const MAX_BUFFER_CACHE    = 25;   // max decoded AudioBuffers kept in heap (~30-50 MB)
function _galleryExpiryMs() {
  const h = Number(loadSettings().galleryRetainHours ?? 24);
  return h > 0 ? h * 60 * 60 * 1000 : Infinity;  // 0 = unlimited
}

const PLACEHOLDER = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60">' +
  '<rect width="80" height="60" fill="%231c2333"/>' +
  '<text x="40" y="38" text-anchor="middle" font-size="28" fill="%23768390">◈</text>' +
  '</svg>'
);

// ── State ────────────────────────────────────────────────────────────────────

const gallery    = {};   // entryId → entry  (keyed by species + site + location)
const heartbeats = {};   // site_name → { site_name, timestamp, receivedAt }
const imgCache  = {};   // speciesKey    → object URL (or PLACEHOLDER)
let activeAudio   = 0;
let soundEnabled  = true;
let audioCtx      = null;     // Web Audio API context — must be created from a user gesture
const playingNow  = new Set();
const bufferCache     = {};   // default asset url → decoded AudioBuffer
const bufferCacheKeys = [];   // insertion order — oldest evicted when cap is hit
let mqttClient  = null;
let db          = null;
let probabilityThreshold = 0; // 0.0–1.0; set via &probability=N URL param
let locationFilter = '';      // set via &location=Name URL param
const imageVariants = {};     // key → count of available images (from manifest.json)

// ── Settings (localStorage) ──────────────────────────────────────────────────

function defaultSettings() {
  return {
    brokerUrl:          '',
    topicPrefix:        'bioacoustics',
    username:           '',
    password:           '',
    autoConnect:        false,
    galleryRetainHours: 168,
  };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem('base-viewer-settings') || '{}') };
  } catch { return defaultSettings(); }
}

function saveSettings(s) {
  localStorage.setItem('base-viewer-settings', JSON.stringify(s));
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('sounds')) d.createObjectStore('sounds', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Image cache ──────────────────────────────────────────────────────────────

async function preloadImageCache() {
  try {
    const all = await dbGetAll('images');
    for (const row of all) {
      const blob = new Blob([row.data], { type: row.mime || 'image/jpeg' });
      imgCache[row.key] = URL.createObjectURL(blob);
    }
  } catch { /* non-fatal */ }
}

function _imgSrc(key) {
  if (imgCache[key]) return imgCache[key];
  const count = imageVariants[key] || 1;
  const n = count > 1 ? Math.floor(Math.random() * count) + 1 : 1;
  return n === 1 ? 'assets/images/' + key + '.jpg' : 'assets/images/' + key + '_' + n + '.jpg';
}

async function loadImageManifest() {
  try {
    const resp = await fetch('assets/images/manifest.json');
    if (resp.ok) Object.assign(imageVariants, await resp.json());
  } catch { /* no manifest — single images only */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _speciesKey(name) {
  return (name || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function _confClass(conf) {
  return conf >= 0.8 ? 'conf-high' : conf >= 0.6 ? 'conf-med' : 'conf-low';
}

function _fmtSeen(date, time) {
  if (!date || !time) return '—';
  const hhmm  = time.slice(0, 5);
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return hhmm;
  const d   = new Date(date + 'T' + time);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${mon} ${hhmm}`;
}

// ── MQTT ─────────────────────────────────────────────────────────────────────

function connect() {
  const s = loadSettings();
  if (!s.brokerUrl) { showSettings(); return; }
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }

  setConnStatus('connecting', 'Connecting…');

  const opts = {
    clientId:        'base-viewer-' + Math.random().toString(16).slice(2, 10),
    clean:           true,
    reconnectPeriod: 5000,
  };
  if (s.username) { opts.username = s.username; opts.password = s.password; }

  try {
    mqttClient = mqtt.connect(s.brokerUrl, opts);
  } catch (e) {
    setConnStatus('disconnected', 'Error: ' + e.message);
    return;
  }

  mqttClient.on('connect', () => {
    setConnStatus('connected', 'Connected');
    const prefix = (s.topicPrefix || 'bioacoustics').replace(/\/$/, '');
    mqttClient.subscribe(prefix + '/detections', err => {
      if (err) console.warn('Subscribe failed:', err.message);
    });
    mqttClient.subscribe(prefix + '/status/+', err => {
      if (err) console.warn('Subscribe status failed:', err.message);
    });
  });

  mqttClient.on('message', (_topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      if (data.type === 'heartbeat' && data.site_name) {
        const receivedAt = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();
        heartbeats[data.site_name] = { ...data, receivedAt };
        renderHeartbeats();
      } else if (data.species_common) {
        updateGallery(data);
      }
    } catch { /* ignore malformed */ }
  });

  mqttClient.on('error',      (err) => setConnStatus('disconnected', 'Error: ' + (err?.message || err)));
  mqttClient.on('disconnect', ()    => setConnStatus('disconnected', 'Disconnected'));
  mqttClient.on('offline',    ()    => setConnStatus('disconnected', 'Offline'));
  mqttClient.on('reconnect',  ()    => setConnStatus('connecting',   'Reconnecting…'));
}

function disconnect() {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  setConnStatus('disconnected', 'Disconnected');
}

// _entryId: unique gallery key — species + site + monitoring location, never mixes sites
function _entryId(det) {
  const sp   = _speciesKey(det.species_common || '');
  const site = _speciesKey(det.site_name || '');
  const loc  = _speciesKey(det.location_name || '');
  const suffix = [site, loc].filter(Boolean).join('_');
  return suffix ? `${sp}__${suffix}` : sp;
}

// Normalise detections from older pipeline versions that used location_name=site, mic_name=location.
function _normalizeDet(det) {
  if (det.site_name !== undefined) return det;   // already new format
  return {
    ...det,
    site_name:     det.location_name || '',
    location_name: det.mic_name      || '',
  };
}

function setConnStatus(state, label) {
  const dot   = document.getElementById('conn-dot');
  const lbl   = document.getElementById('conn-label');
  const badge = document.getElementById('live-badge');
  if (dot)   dot.className = 'conn-dot ' + state;
  if (lbl)   lbl.textContent = label;
  if (badge) badge.classList.toggle('live-on', state === 'connected');
}

// ── Gallery ──────────────────────────────────────────────────────────────────

function updateGallery(rawDet) {
  const det    = _normalizeDet(rawDet);
  const key    = _speciesKey(det.species_common);
  const eid    = _entryId(det);
  const ts     = (det.date && det.time) ? new Date(det.date + 'T' + det.time).getTime() : Date.now();

  if (!gallery[eid]) {
    gallery[eid] = {
      det, key, entryId: eid, count: 1, bestConf: det.confidence,
      firstSeen:  { date: det.date, time: det.time },
      lastSeen:   { date: det.date, time: det.time },
      lastSeenTs: ts,
    };
  } else {
    const e = gallery[eid];
    e.det        = det;   // always refresh so location stays accurate
    e.count++;
    if (det.confidence > e.bestConf) e.bestConf = det.confidence;
    e.lastSeen   = { date: det.date, time: det.time };
    e.lastSeenTs = ts;
  }

  saveGalleryToStorage();
  renderGallery(eid);
  playDetectionSound(key);
}

function getFilteredEntries() {
  return Object.values(gallery)
    .filter(e => e.bestConf >= probabilityThreshold)
    .filter(e => !locationFilter || [e.det.site_name, e.det.location_name].some(v => (v || '').toLowerCase() === locationFilter.toLowerCase()))
    .sort((a, b) => (b.lastSeenTs || 0) - (a.lastSeenTs || 0));
}

let _renderTimer   = null;
let _renderPending = null;  // last flashName queued during debounce window

function renderGallery(flashName) {
  if (flashName) _renderPending = flashName;
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    _doRenderGallery(_renderPending);
    _renderPending = null;
  }, 300);
}

function _doRenderGallery(flashName) {
  const grid  = document.getElementById('gallery-grid');
  const empty = document.getElementById('empty-state');
  if (!grid) return;

  const entries = getFilteredEntries();

  if (!entries.length) {
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = '';
    grid.style.gridAutoRows = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = entries.map(e => galleryCard(e)).join('');
  setTimeout(updateGridLayout, 0);

  if (flashName) {
    const el = document.getElementById('card-' + flashName);
    if (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }
}

// ── Icon set — simple white SVGs, consistent across all platforms ─────────────

const _ICONS = {
  soundOn:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 6.5h2l3.5-2.5v8L5 9.5H3a.5.5 0 0 1-.5-.5V7a.5.5 0 0 1 .5-.5z"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5m2-7a6.5 6.5 0 0 1 0 9" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  soundOff: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 6.5h2l3.5-2.5v8L5 9.5H3a.5.5 0 0 1-.5-.5V7a.5.5 0 0 1 .5-.5z"/><line x1="11" y1="6" x2="15" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/><line x1="15" y1="6" x2="11" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`,
  info:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7.5" x2="8" y2="11"/><circle cx="8" cy="5.5" r=".6" fill="currentColor" stroke="none"/></svg>`,
  leaf:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 1.5c0 5.5-2 8.5-5 10.5a7 7 0 0 1-5.5-1c1-3 3-5 10.5-9.5z"/><path d="M3.5 13l2-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3"/></svg>`,
  signal:   `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="13" r=".8" fill="currentColor" stroke="none"/><path d="M5 10.5a4.2 4.2 0 0 1 6 0"/><path d="M2.5 8a8 8 0 0 1 11 0"/></svg>`,
  pin:      `<svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor" aria-hidden="true"><path d="M5 0a4 4 0 0 0-4 4c0 3 4 9 4 9s4-6 4-9a4 4 0 0 0-4-4zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`,
  arrowUp:  `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8V2M2 5l3-3 3 3"/></svg>`,
  arrowDn:  `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2v6M2 5l3 3 3-3"/></svg>`,
};

// ── Weather icons + strip ─────────────────────────────────────────────────────

const _WX = {
  temp:     `<svg width="9" height="13" viewBox="0 0 9 13" fill="currentColor"><rect x="3" y="0" width="3" height="7.5" rx="1.5"/><rect x="3" y="6" width="3" height="3"/><circle cx="4.5" cy="10.5" r="2.5"/></svg>`,
  wind:     `<svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 3h8a2 2 0 0 0 0-4"/><path d="M1 7h10a2 2 0 0 1 0 4"/></svg>`,
  humidity: `<svg width="9" height="12" viewBox="0 0 9 12" fill="currentColor"><path d="M4.5 0C3 3 0 6 0 8.5a4.5 4.5 0 0 0 9 0C9 6 6 3 4.5 0z"/></svg>`,
  rain:     `<svg width="10" height="13" viewBox="0 0 10 13" fill="currentColor"><path d="M5 0C3.5 3 0 6 0 8.5a5 5 0 0 0 10 0C10 6 6.5 3 5 0z" opacity="0.65"/><line x1="2" y1="11" x2="1" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="5" y1="11.5" x2="4" y2="13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="8" y1="11" x2="7" y2="13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
};

function _weatherStrip(det) {
  if (det.temperature_c === null || det.temperature_c === undefined) return '';
  const parts = [];
  if (det.temperature_c  != null) parts.push(`<span class="wx-item">${_WX.temp}${det.temperature_c.toFixed(1)}°C</span>`);
  if (det.wind_speed_kmh != null) parts.push(`<span class="wx-item">${_WX.wind}${(det.wind_speed_kmh * 0.621371).toFixed(1)}mph</span>`);
  if (det.humidity_pct   != null) parts.push(`<span class="wx-item">${_WX.humidity}${Math.round(det.humidity_pct)}%</span>`);
  if (det.precipitation_mm > 0)   parts.push(`<span class="wx-item">${_WX.rain}${det.precipitation_mm}mm</span>`);
  return parts.length ? `<div class="weather-strip">${parts.join('')}</div>` : '';
}

function galleryCard(entry) {
  const { det, key, entryId, count, bestConf, firstSeen, lastSeen } = entry;
  const pct = Math.round(bestConf * 100);
  const locDisplay = [det.site_name, det.location_name].filter(Boolean).join(' · ');

  return `
    <div class="gallery-card" id="card-${entryId}" onclick="showSpeciesDetail('${entryId.replace(/'/g, "\\'")}')">
      <div class="card-img-wrap">
        <img src="${_imgSrc(key)}" alt="${det.species_common}"
             onerror="this.onerror=null;this.src='${PLACEHOLDER}';this.classList.add('img-placeholder')">
        <span class="card-count">×${count}</span>
        <span class="card-conf ${_confClass(bestConf)}">${pct}%</span>
      </div>
      <div class="card-info">
        <div class="card-name-row">
          <span class="card-name">${det.species_common}</span>
        </div>
        <div class="card-sci">${det.species_scientific || ''}</div>
        <div class="card-meta-row">
          ${det.classifier ? `<span class="card-clf">${det.classifier}</span>` : ''}
          ${locDisplay ? `<span class="card-loc-badge">${_ICONS.pin} ${locDisplay}</span>` : ''}
        </div>
        <div class="card-times">
          <span title="First detected">${_ICONS.arrowUp} ${_fmtSeen(firstSeen?.date, firstSeen?.time)}</span>
          <span title="Last detected">${_ICONS.arrowDn} ${_fmtSeen(lastSeen?.date,  lastSeen?.time)}</span>
        </div>
        ${_weatherStrip(det)}
      </div>
    </div>`;
}

// ── Daily gallery persistence (localStorage) ─────────────────────────────────

function _todayKey() {
  return new Date().toISOString().slice(0, 10);
}

let _saveTimer = null;
function saveGalleryToStorage() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      localStorage.setItem('base-viewer-gallery', JSON.stringify({ date: _todayKey(), gallery }));
    } catch { /* storage full or unavailable */ }
  }, 30000);
}

function loadGalleryFromStorage() {
  try {
    const stored = JSON.parse(localStorage.getItem('base-viewer-gallery') || 'null');
    if (stored?.date === _todayKey() && stored.gallery) {
      for (const entry of Object.values(stored.gallery)) {
        if (!entry?.det?.species_common) continue;
        const det = _normalizeDet(entry.det);
        const eid = _entryId(det);
        gallery[eid] = { ...entry, det, entryId: eid, key: _speciesKey(det.species_common) };
      }
    }
  } catch { /* corrupt data — start fresh */ }
}

function purgeStaleGallery() {
  const cutoff = Date.now() - _galleryExpiryMs();
  let changed = false;

  for (const name of Object.keys(gallery)) {
    if ((gallery[name].lastSeenTs || 0) < cutoff) {
      delete gallery[name];
      changed = true;
    }
  }

  // Hard cap: evict oldest entries beyond MAX_GALLERY_ENTRIES
  const all = Object.values(gallery).sort((a, b) => (a.lastSeenTs || 0) - (b.lastSeenTs || 0));
  if (all.length > MAX_GALLERY_ENTRIES) {
    for (const e of all.slice(0, all.length - MAX_GALLERY_ENTRIES)) {
      delete gallery[e.entryId];
      changed = true;
    }
  }

  if (changed) {
    saveGalleryToStorage();
    renderGallery();
  }
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function _unlockAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || (/** @type {any} */ (window)).webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  // Play a silent buffer — required to fully unlock on iOS
  const buf = audioCtx.createBuffer(1, 1, 22050);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start(0);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  if (soundEnabled) _unlockAudioContext();  // user gesture — unlock iOS audio here
  _updateSoundBtn();
}

function _updateSoundBtn() {
  const btn = document.getElementById('sound-unlock-btn');
  if (!btn) return;
  if (soundEnabled) {
    btn.innerHTML = _ICONS.soundOn;
    btn.title = 'Sounds on';
    btn.classList.add('sound-on');
  } else {
    btn.innerHTML = _ICONS.soundOff;
    btn.title = 'Sounds off';
    btn.classList.remove('sound-on');
  }
}

async function playDetectionSound(key) {
  if (!soundEnabled || !audioCtx || audioCtx.state !== 'running') return;
  if (playingNow.has(key)) return;
  if (activeAudio >= MAX_SIMULTANEOUS_AUDIO) return;

  try {
    let audioBuffer;
    const record = await dbGet('sounds', key);

    if (record?.clips?.length) {
      // User-uploaded: decode a copy (decodeAudioData detaches the ArrayBuffer)
      const clip = record.clips[Math.floor(Math.random() * record.clips.length)];
      audioBuffer = await audioCtx.decodeAudioData(clip.data.slice(0));
    } else {
      // Default asset: fetch once and cache the decoded buffer, evicting oldest if over cap
      const assetUrl = 'assets/sounds/' + key + '.mp3';
      if (!bufferCache[assetUrl]) {
        const resp = await fetch(assetUrl);
        if (!resp.ok) return;
        bufferCache[assetUrl] = await audioCtx.decodeAudioData(await resp.arrayBuffer());
        bufferCacheKeys.push(assetUrl);
        if (bufferCacheKeys.length > MAX_BUFFER_CACHE) {
          delete bufferCache[bufferCacheKeys.shift()];
        }
      }
      audioBuffer = bufferCache[assetUrl];
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.65;
    source.connect(gain);
    gain.connect(audioCtx.destination);

    activeAudio++;
    playingNow.add(key);
    source.onended = () => { activeAudio--; playingNow.delete(key); };
    source.start(0);

  } catch { /* file missing or decode error — skip silently */ }
}

// ── Settings UI ──────────────────────────────────────────────────────────────

function checkBrokerUrl() {
  const input = document.getElementById('s-url');
  const warn  = document.getElementById('url-warn');
  if (!input || !warn) return;
  const val = input.value.trim();
  if (!val) { warn.style.display = 'none'; return; }

  if (!/^(wss?|mqtts?):\/\//.test(val)) {
    warn.innerHTML = 'URL must include a scheme: <strong>wss://</strong>, <strong>ws://</strong>, or <strong>mqtts://</strong>.';
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}

function showSettings() {
  const s = loadSettings();
  document.getElementById('s-url').value          = s.brokerUrl || '';
  document.getElementById('s-prefix').value       = s.topicPrefix || 'bioacoustics';
  document.getElementById('s-username').value     = s.username || '';
  document.getElementById('s-password').value     = s.password || '';
  document.getElementById('s-autoconnect').checked = !!s.autoConnect;
  document.getElementById('s-retain').value = String(s.galleryRetainHours ?? 24);
  document.getElementById('settings-overlay').classList.add('open');
  document.getElementById('settings-panel').classList.add('open');
  checkBrokerUrl();
}

function hideSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('settings-panel').classList.remove('open');
}

function applySettings(e) {
  e.preventDefault();
  saveSettings({
    brokerUrl:          document.getElementById('s-url').value.trim(),
    topicPrefix:        document.getElementById('s-prefix').value.trim() || 'bioacoustics',
    username:           document.getElementById('s-username').value,
    password:           document.getElementById('s-password').value,
    autoConnect:        document.getElementById('s-autoconnect').checked,
    galleryRetainHours: Number(document.getElementById('s-retain').value),
  });
  hideSettings();
  connect();
}

// ── Species detail modal ──────────────────────────────────────────────────────

async function showSpeciesDetail(entryId) {
  const entry = gallery[entryId];
  if (!entry) return;
  document.getElementById('modal-title').textContent = entry.det.species_common;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('species-modal').classList.add('open');
  await _renderModalBody(entryId, entry.key, entry);
}

function hideModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('species-modal').classList.remove('open');
}

async function _renderModalBody(entryId, key, entry) {
  const { det, count } = entry;
  const sounds = await dbGet('sounds', key);
  const clips  = sounds?.clips || [];
  const hasImg = imgCache[key] && imgCache[key] !== PLACEHOLDER;
  const locDisplay = [det.site_name, det.location_name].filter(Boolean).join(' · ');
  const safeEid = entryId.replace(/'/g, "\\'");

  const soundItems = clips.map((c, i) => `
    <li class="sound-item">
      <span class="sound-name">${c.name}</span>
      <button class="btn btn-sm btn-outline" onclick="previewSound('${key}', ${i})">▶</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSound('${key}', ${i}, '${safeEid}')">✕</button>
    </li>`).join('');

  document.getElementById('modal-body').innerHTML = `
    ${hasImg ? `<img class="modal-img" src="${imgCache[key]}" alt="${det.species_common}">` : ''}

    <div class="modal-meta">
      ${det.species_scientific ? `<em>${det.species_scientific}</em><br>` : ''}
      ${count} detection${count !== 1 ? 's' : ''} this session
      ${locDisplay ? ' · ' + locDisplay : ''}
    </div>

    <hr class="modal-divider">

    <div class="modal-section-title">Photo</div>
    ${!hasImg ? `<p style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">Default: <code>assets/images/${key}.jpg</code></p>` : ''}
    <label class="upload-area">
      ${hasImg ? '↑ Replace photo' : '+ Upload your own'} (JPEG, PNG, WebP)
      <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none"
             onchange="uploadImage('${key}', this, '${safeEid}')">
    </label>

    <hr class="modal-divider">

    <div class="modal-section-title">Sounds — play randomly on detection (${clips.length}/${MAX_SOUNDS})</div>
    ${clips.length ? `<ul class="sound-list">${soundItems}</ul>` : `<p style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">Default: <code>assets/sounds/${key}.mp3</code></p>`}
    ${clips.length < MAX_SOUNDS ? `
    <label class="upload-area">
      + Upload your own sound${clips.length ? 's' : ''} (MP3, WAV, OGG — up to ${MAX_SOUNDS - clips.length} more)
      <input type="file" accept="audio/*" multiple style="display:none"
             onchange="uploadSounds('${key}', this, '${safeEid}')">
    </label>` : ''}`;
}

// ── Image management ──────────────────────────────────────────────────────────

async function uploadImage(key, input, entryId) {
  const file = input.files[0];
  if (!file) return;
  const data = await file.arrayBuffer();
  await dbPut('images', { key, data, mime: file.type });
  if (imgCache[key]) URL.revokeObjectURL(imgCache[key]);
  imgCache[key] = URL.createObjectURL(new Blob([data], { type: file.type }));
  renderGallery();
  const entry = gallery[entryId];
  if (entry) await _renderModalBody(entryId, key, entry);
}

// ── Sound management ──────────────────────────────────────────────────────────

async function uploadSounds(key, input, entryId) {
  const files  = Array.from(input.files);
  const record = (await dbGet('sounds', key)) || { key, clips: [] };
  const slots  = MAX_SOUNDS - record.clips.length;
  for (const file of files.slice(0, slots)) {
    const data = await file.arrayBuffer();
    record.clips.push({ name: file.name, data, mime: file.type });
  }
  await dbPut('sounds', record);
  const entry = gallery[entryId];
  if (entry) await _renderModalBody(entryId, key, entry);
}

async function deleteSound(key, index, entryId) {
  const record = await dbGet('sounds', key);
  if (!record) return;
  record.clips.splice(index, 1);
  if (record.clips.length) {
    await dbPut('sounds', record);
  } else {
    await dbDelete('sounds', key);
  }
  const entry = gallery[entryId];
  if (entry) await _renderModalBody(entryId, key, entry);
}

async function previewSound(key, index) {
  const record = await dbGet('sounds', key);
  if (!record?.clips[index]) return;
  const clip  = record.clips[index];
  const blob  = new Blob([clip.data], { type: clip.mime || 'audio/mpeg' });
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => {});
  audio.onended = () => URL.revokeObjectURL(url);
}

// ── Layout: fill viewport ────────────────────────────────────────────────────

function _resizeMain() {
  const main      = document.getElementById('main');
  const header    = document.getElementById('header');
  const footer    = document.getElementById('attribution-footer');
  const explainer = document.getElementById('explainer-tile');
  const safeBar   = document.getElementById('safe-area-bar');
  if (!main || !header) return;

  const safeTop    = safeBar ? safeBar.offsetHeight : 0;  // env(safe-area-inset-top) via element
  const footerH    = footer ? footer.offsetHeight : 0;
  const isDesktop  = window.innerWidth > 600 && window.innerHeight > 500;
  const explainerH = (isDesktop && !document.body.classList.contains('explainer-hidden'))
    ? (explainer?.offsetHeight || 0) : 0;
  // Push main below the sticky header which itself is offset by the safe area bar
  main.style.marginTop = safeTop + 'px';
  const h = window.innerHeight - safeTop - header.offsetHeight - footerH - explainerH;
  main.style.height    = Math.max(180, h) + 'px';
  main.style.overflowY = 'auto';
}

function updateGridLayout() {
  // Mobile landscape uses a fixed 3-col overlay layout — leave it to CSS
  if (window.innerHeight < 500 && window.matchMedia('(orientation: landscape)').matches) {
    const g = document.getElementById('gallery-grid');
    if (g) g.style.gridTemplateColumns = '';
    return;
  }

  const grid = document.getElementById('gallery-grid');
  const main = document.getElementById('main');
  if (!grid || !main) return;

  const count = getFilteredEntries().length;
  if (!count) { grid.style.gridTemplateColumns = ''; return; }

  // Column count only — row height is determined by card content (4:3 image + info)
  const availW = main.clientWidth - 32;
  let cols;
  if (availW < 480)       cols = Math.min(count, 2);
  else if (availW < 720)  cols = Math.min(count, 3);
  else if (availW < 1100) cols = Math.min(count, 4);
  else                    cols = Math.min(count, 5);

  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}


// ── Explainer modal (mobile) / hide bar (desktop) ────────────────────────────

function toggleExplainer() {
  // Desktop: toggle the explainer bar hidden/visible
  if (window.innerWidth > 600 && window.innerHeight > 500) {
    document.body.classList.toggle('explainer-hidden');
    try {
      localStorage.setItem('base-explainer-hidden',
        document.body.classList.contains('explainer-hidden') ? '1' : '0');
    } catch { /* storage unavailable */ }
    _resizeMain();
    updateGridLayout();
    return;
  }
  // Mobile: open as centred modal
  const tile    = document.getElementById('explainer-tile');
  const overlay = document.getElementById('explainer-overlay');
  const open    = tile.classList.toggle('open');
  overlay.classList.toggle('open', open);
}

// ── About modal ──────────────────────────────────────────────────────────────

function showAbout() {
  document.getElementById('about-overlay').classList.add('open');
}

function hideAbout() {
  document.getElementById('about-overlay').classList.remove('open');
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Device heartbeat status ───────────────────────────────────────────────────

function _timeAgo(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 120)  return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} days ago`;
}

function _hbDotClass(receivedAt) {
  const hrs = (Date.now() - receivedAt) / 3600000;
  if (hrs < 2)  return 'fresh';
  if (hrs < 24) return 'recent';
  return 'stale';
}

function renderHeartbeats() {
  const list = document.getElementById('device-status-list');
  const btn  = document.getElementById('device-status-btn');
  if (!list) return;

  const sites = Object.values(heartbeats);
  if (!sites.length) {
    list.innerHTML = '<em style="color:var(--muted);font-size:0.78rem">No heartbeats received yet</em>';
    if (btn) btn.classList.remove('has-stale');
    return;
  }

  const hasStale = sites.some(s => _hbDotClass(s.receivedAt) !== 'fresh');
  if (btn) btn.classList.toggle('has-stale', hasStale);

  list.innerHTML = sites
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .map(s => `
      <div class="hb-row">
        <span class="hb-dot ${_hbDotClass(s.receivedAt)}"></span>
        <span class="hb-site">${s.site_name}</span>
        <span class="hb-time">${_timeAgo(s.receivedAt)}</span>
      </div>`)
    .join('');
}

function toggleDeviceStatus() {
  const panel = document.getElementById('device-status-panel');
  if (panel) panel.classList.toggle('open');
}

// Close panel when clicking outside
document.addEventListener('click', e => {
  const panel = document.getElementById('device-status-panel');
  const btn   = document.getElementById('device-status-btn');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) {
    panel.classList.remove('open');
  }
});

// Refresh relative times every minute so "2 min ago" stays accurate
setInterval(renderHeartbeats, 60000);

async function init() {
  db = await openDb();
  await preloadImageCache();
  await loadImageManifest();

  // URL params override stored settings — useful for kiosk/Yodeck deployments
  // where you can't interact with the settings panel.
  // e.g. ?broker=wss://host:8084/mqtt&username=base&password=secret&prefix=bioacoustics
  const params = new URLSearchParams(window.location.search);
  if (params.has('broker')) {
    saveSettings({
      brokerUrl:   params.get('broker'),
      topicPrefix: params.get('prefix')   || 'bioacoustics',
      username:    params.get('username') || '',
      password:    params.get('password') || '',
      autoConnect: true,
    });
  }

  if (params.has('probability')) {
    const pct = Math.min(100, Math.max(0, parseInt(params.get('probability'), 10) || 0));
    probabilityThreshold = pct / 100;
  }

  if (params.has('location')) {
    locationFilter = params.get('location');
  }

  const locEl = document.getElementById('live-loc-text');
  if (locEl) locEl.textContent = locationFilter || 'Monitoring';

  const yearEl = document.getElementById('footer-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Stamp version into header and about modal
  const verEls = [document.getElementById('viewer-version'), document.getElementById('about-version')];
  verEls.forEach(el => { if (el) el.textContent = `v${BASE_VERSION}`; });

  // Restore explainer hidden state
  try {
    if (localStorage.getItem('base-explainer-hidden') === '1') {
      document.body.classList.add('explainer-hidden');
    }
  } catch { /* storage unavailable */ }

  // Auto-hide the explainer after 30 s so it doesn't linger on a kiosk screen
  setTimeout(() => {
    if (!document.body.classList.contains('explainer-hidden')) {
      document.body.classList.add('explainer-hidden');
      _resizeMain();
      updateGridLayout();
    }
  }, 30000);

  _resizeMain();
  window.addEventListener('resize', () => { _resizeMain(); updateGridLayout(); });

  loadGalleryFromStorage();
  purgeStaleGallery();
  renderGallery();
  setInterval(purgeStaleGallery, 2 * 60 * 1000);  // sweep for expired entries every 2 min

  _updateSoundBtn();

  const s = loadSettings();
  if (s.autoConnect && s.brokerUrl) connect();

  // Re-establish MQTT when the user returns to the tab/PWA after it was backgrounded.
  // On iOS the WebSocket is always dropped when the app is suspended — these handlers
  // trigger an immediate reconnect the moment the page becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _ensureConnected();
  });
  // Page Lifecycle API — fires when a frozen page is thawed (Android, desktop)
  window.addEventListener('resume', _ensureConnected);
  // Back-forward cache restore (iOS Safari, Firefox)
  window.addEventListener('pageshow', (e) => { if (e.persisted) _ensureConnected(); });
  // Network restored after going offline
  window.addEventListener('online', _ensureConnected);
}

// Reconnect MQTT if the client is gone or has stopped trying.
// Safe to call repeatedly — does nothing when already connected.
function _ensureConnected() {
  const s = loadSettings();
  if (!s.autoConnect || !s.brokerUrl) return;
  if (!mqttClient || (!mqttClient.connected && !mqttClient.reconnecting)) {
    connect();
  }
}

document.addEventListener('DOMContentLoaded', init);
