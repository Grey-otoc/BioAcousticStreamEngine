/* Bioacoustic Stream Engine — single-page frontend */

const MAX_FEED_ITEMS = 60;
const POLL_INTERVAL = 8000;

const CLASSIFIERS = [
  { key: 'all',    label: 'All',      icon: '◈' },
  { key: 'bird',   label: 'Birds',    icon: '🐦' },
  { key: 'bat',    label: 'Bats',     icon: '🦇' },
  { key: 'bee',    label: 'Bees',     icon: '🐝' },
  { key: 'insect', label: 'Insects',  icon: '🦗' },
  { key: 'soil',   label: 'Soil',     icon: '🌱' },
  { key: 'water',  label: 'Water',    icon: '💧' },
];

const state = {
  page: 'dashboard',
  status: null,
  detections: [],
  classifierFilter: 'all',
  connected: true,
  gallery: {},  // key: species_common → { det, count, bestConf }
};

/* ── API ── */
const api = {
  async _request(path, opts = {}) {
    try {
      const r = await fetch(path, opts);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const detail = Array.isArray(body.detail)
          ? body.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
          : body.detail || `Server error (${r.status})`;
        throw new Error(detail);
      }
      return r.json();
    } catch (e) {
      if (e.name === 'TypeError') throw new Error('Cannot reach server — check that the web UI is still running.');
      throw e;
    }
  },
  get(path) { return this._request(path); },
  post(path, body = {}) {
    return this._request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  patch(path, body = {}) {
    return this._request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  del(path) { return this._request(path, { method: 'DELETE' }); },
};

/* ── Toast ── */
function toast(msg, type = 'info', duration = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show toast-${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, duration);
}

/* ── Button loading ── */
function btnLoad(btn, label) { btn.dataset.loading = '1'; btn._orig = btn.textContent; btn.textContent = label; }
function btnDone(btn) { delete btn.dataset.loading; if (btn._orig) btn.textContent = btn._orig; }

/* ── Connection warning ── */
function setConnected(ok) {
  if (state.connected === ok) return;
  state.connected = ok;
  document.getElementById('conn-warning').classList.toggle('show', !ok);
}

/* ── Header ── */
function updateHeader(status) {
  if (!status) return;
  document.getElementById('version').textContent = `v${status.version}`;
  const pill = document.getElementById('status-pill');
  const lbl = document.getElementById('status-label');
  const running = Object.values(status.pipelines || {}).filter(p => p.state !== 'idle');
  if (running.length === 0) {
    pill.className = 'status-pill idle'; lbl.textContent = 'Idle';
  } else if (running.length === 1) {
    pill.className = `status-pill ${running[0].state}`;
    lbl.textContent = `${running[0].state === 'listening' ? 'Listening' : 'Scheduled'} — ${running[0].device_name}`;
  } else {
    pill.className = 'status-pill listening';
    lbl.textContent = `${running.length} devices active`;
  }
}

/* ── State banner ── */
function updateStateBanner(pipelines) {
  const banner = document.getElementById('state-banner');
  if (!banner) return;
  const running = Object.values(pipelines).filter(p => p.state !== 'idle');
  if (running.length === 0) {
    banner.className = 'state-banner';
    banner.querySelector('.banner-title').textContent = 'Ready to listen';
    banner.querySelector('.banner-sub').textContent = 'Configure your monitoring locations below, then press Start All.';
  } else if (running.length === 1) {
    const p = running[0];
    banner.className = `state-banner ${p.state}`;
    banner.querySelector('.banner-title').textContent = p.state === 'listening' ? '● Listening now' : '● Scheduled mode running';
    banner.querySelector('.banner-sub').textContent = `${p.device_name}  ·  Window: ${p.window || 'manual'}  ·  Started ${fmtTime(p.started_at)}`;
  } else {
    banner.className = 'state-banner listening';
    banner.querySelector('.banner-title').textContent = `● ${running.length} locations recording`;
    banner.querySelector('.banner-sub').textContent = running.map(p => p.device_name).join(', ');
  }
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/* ── Organism tabs ── */
function renderTabs(containerId) {
  const counts = {};
  CLASSIFIERS.forEach(c => counts[c.key] = 0);
  state.detections.forEach(d => {
    counts['all']++;
    if (counts[d.classifier] !== undefined) counts[d.classifier]++;
    else counts[d.classifier] = 1;
  });

  return `<div class="tabs" id="${containerId}">
    ${CLASSIFIERS.map(c => `
      <button class="tab ${state.classifierFilter === c.key ? 'active' : ''}"
              onclick="setFilter('${c.key}')">
        ${c.icon} ${c.label}
        <span class="tab-count">${counts[c.key] || 0}</span>
      </button>`).join('')}
  </div>`;
}

function setFilter(key) {
  state.classifierFilter = key;
  // Re-render tabs
  const tabsEl = document.getElementById('feed-tabs');
  if (tabsEl) tabsEl.outerHTML = renderTabs('feed-tabs');
  // Re-render feed
  const feed = document.getElementById('live-feed');
  if (feed) {
    const visible = state.classifierFilter === 'all'
      ? state.detections
      : state.detections.filter(d => d.classifier === state.classifierFilter);
    feed.innerHTML = visible.slice(0, MAX_FEED_ITEMS).map(detectionCard).join('');
  }
}

/* ── Router ── */
const router = {
  init() {
    window.addEventListener('hashchange', () => this.navigate(location.hash.slice(1) || 'dashboard'));
    document.querySelectorAll('nav a').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); location.hash = a.getAttribute('href').slice(1); });
    });
    this.navigate(location.hash.slice(1) || 'dashboard');
  },
  navigate(page) {
    // Release AudioContext and mic track before replacing the page DOM.
    // Without this, each visit to the dashboard leaks an AudioContext; Chrome
    // silently fails to create new ones after ~6 leaked instances.
    if (_spec.running) _stopSpectrogram();
    state.page = page;
    document.querySelectorAll('nav a').forEach(a =>
      a.classList.toggle('active', a.getAttribute('href') === `#${page}`)
    );
    try {
      ({ dashboard: renderDashboard, gallery: renderGallery, schedule: renderSchedule, clips: renderClips, reports: renderReports, analytics: renderAnalytics, settings: renderSettings, testfile: renderTestFile }[page] || renderDashboard)();
    } catch (err) {
      document.getElementById('main').innerHTML = `<div style="padding:32px;color:var(--danger,#e55)"><strong>Page error:</strong> ${err.message}</div>`;
      console.error('Router render error:', err);
    }
  },
};

/* ── WebSocket ── */
const ws = {
  socket: null,
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket.onmessage = e => { try { this.onMessage(JSON.parse(e.data)); } catch (_) {} };
    this.socket.onclose = () => setTimeout(() => this.connect(), 2000);
  },
  onMessage(data) {
    if (data.type === 'detection') {
      state.detections.unshift(data);
      if (state.detections.length > MAX_FEED_ITEMS) state.detections.pop();
      updateGallery(data);
      if (state.page === 'dashboard') prependDetection(data);
      const tabsEl = document.getElementById('feed-tabs');
      if (tabsEl) tabsEl.outerHTML = renderTabs('feed-tabs');
    } else if (data.type === 'audio_level') {
      updateVuMeter(data.db);
    } else if (data.type === 'pipeline_stopped') {
      resetVuMeter();
    }
  },
};

/* ── Status polling ── */
async function pollStatus() {
  try {
    state.status = await api.get('/api/status');
    setConnected(true);
    updateHeader(state.status);
    if (state.page === 'dashboard') {
      updateStateBanner(state.status.pipelines || {});
      // Update status-derived stat cards directly from what we already have
      const windowEl = document.getElementById('stat-window')?.querySelector('.value');
      if (windowEl) {
        const anyRunning = Object.values(state.status.pipelines || {}).find(p => p.state !== 'idle');
        windowEl.textContent = anyRunning?.window || '—';
      }
      const diskEl = document.getElementById('stat-disk')?.querySelector('.value');
      if (diskEl) diskEl.textContent = state.status.disk_free_gb ?? '—';
      loadMicClfPanel();
      _refreshSummaryStats();
    }
  } catch (_) { setConnected(false); }
}

async function _refreshSummaryStats() {
  try {
    const summary = await api.get('/api/detections/summary');
    const speciesEl = document.getElementById('stat-species')?.querySelector('.value');
    const callsEl   = document.getElementById('stat-calls')?.querySelector('.value');
    if (speciesEl) speciesEl.textContent = summary.species_count ?? '—';
    if (callsEl)   callsEl.textContent   = summary.total_calls   ?? '—';
  } catch (_) {}
}

/* ─────────────────────────── DASHBOARD ─────────────────────────── */
function renderDashboard() {
  document.getElementById('main').innerHTML = `
    <div class="dashboard-layout">

      <div class="dashboard-main-col">
        <div class="grid-4">
          <div class="card stat" id="stat-species"><div class="value">—</div><div class="label">Species today</div></div>
          <div class="card stat" id="stat-calls"><div class="value">—</div><div class="label">Calls today</div></div>
          <div class="card stat" id="stat-window"><div class="value" style="font-size:1rem">—</div><div class="label">Active window</div></div>
          <div class="card stat" id="stat-disk"><div class="value">—</div><div class="label">Disk free (GB)</div></div>
        </div>

        <div class="card">
          <div class="card-title">Status</div>
          <div class="state-banner" id="state-banner">
            <div class="banner-dot"></div>
            <div class="banner-text">
              <div class="banner-title">Ready to listen</div>
              <div class="banner-sub">Configure your monitoring locations below, then press Start All.</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div class="card-title" style="margin:0">Live Spectrogram ${helpBtn('spectrogram')}</div>
            <div style="display:flex;gap:6px;align-items:center">
              <button class="btn btn-sm btn-outline" id="btn-spec-monitor" onclick="toggleMonitor()" title="Listen in" style="font-size:1rem;padding:4px 8px">🎧</button>
              <button class="btn btn-sm btn-outline" id="btn-spec-toggle" onclick="toggleSpectrogram()">■ Stop</button>
            </div>
          </div>
          <div class="spec-panel show" id="spec-panel">
            <div class="spec-toolbar">
              <label class="spec-tb-label">Location</label>
              <select id="spec-location" onchange="onSpecLocationChange()" class="spec-tb-select"></select>
              <span id="spec-mic-badge" class="spec-mic-badge" style="display:none"></span>
              <div id="spec-any-mic" style="display:flex;align-items:center;gap:6px">
                <label class="spec-tb-label">Mic</label>
                <select id="spec-device" onchange="changeSpecDevice()" class="spec-tb-select spec-tb-select--mic"><option value="">System default</option></select>
              </div>
              <label class="spec-tb-label" style="margin-left:4px"><input type="checkbox" id="spec-log" style="accent-color:var(--primary)"> Log scale</label>
            </div>
            <div class="spec-wrap">
              <canvas id="spec-canvas" width="1200" height="220"></canvas>
              <div class="spec-freq-axis" id="spec-axis"></div>
              <div id="spec-preset-badge" class="spec-overlay-badge" style="display:none"></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Recording Locations</div>
          <div id="mic-clf-panel"><div class="empty">Loading...</div></div>
        </div>
      </div>

      <div class="dashboard-feed-col">
        <div class="card dashboard-feed-card">
          <div class="card-title">Live Detections ${helpBtn('live_detections')}</div>
          <div class="vu-meter" id="vu-meter">
            <span class="vu-label">🎙 Audio in ${helpBtn('vu_meter')}</span>
            <div class="vu-bar-wrap"><div class="vu-bar" id="vu-bar"></div></div>
            <span class="vu-db" id="vu-db"><span class="vu-no-signal">no signal</span></span>
          </div>
          ${renderTabs('feed-tabs')}
          <div class="feed" id="live-feed"></div>
        </div>
      </div>

    </div>

  `;

  refreshDashboard();
  _populateSpecDevices().then(() => _startSpectrogram());
}

async function refreshDashboard() {
  if (state.page !== 'dashboard') return;
  await pollStatus();
}

async function refreshDevicePanel() {
  const panel = document.getElementById('device-panel');
  if (!panel) return;
  try {
    const [devData, statusData, micsData, schedData, clfData] = await Promise.all([
      api.get('/api/devices'),
      state.status ? Promise.resolve(state.status) : api.get('/api/status'),
      api.get('/api/settings/mics').catch(() => []),
      api.get('/api/schedule').catch(() => ({ windows: [] })),
      api.get('/api/settings/classifiers').catch(() => ({ active: [], devices: {} })),
    ]);

    // If any monitoring locations have classifiers configured, show those instead of
    // raw PipeWire devices — they are the real recording units for the multi-mic model.
    const configuredMics = micsData.filter(m => (m.classifiers || []).length > 0);
    if (configuredMics.length > 0) {
      _refreshMicLocationPanel(panel, configuredMics, statusData, schedData);
      return;
    }

    const schedWindows = schedData.windows || [];
    const activeWin = schedWindows.find(w => w.active) || null;
    const nextWin = (() => {
      if (activeWin) return null;
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      return schedWindows
        .map(w => { const [h, m] = w.start.split(':').map(Number); return { ...w, startMins: h * 60 + m }; })
        .filter(w => w.startMins > nowMins)
        .sort((a, b) => a.startMins - b.startMins)[0] || null;
    })();
    const schedTag = activeWin
      ? `<span class="sched-tag sched-active">${activeWin.name.replace(/_/g, ' ')}</span>`
      : nextWin
        ? `<span class="sched-tag sched-next">next: ${nextWin.name.replace(/_/g, ' ')} ${nextWin.start}</span>`
        : '';
    const pipelines = statusData.pipelines || {};
    const deviceLocs = _loadDeviceLocs();

    // Build reverse map: PipeWire source name → active classifiers assigned to it
    const clfActive = new Set(clfData.active || []);
    const deviceClfMap = {};
    const defaultClfs = [];
    for (const [clf, devName] of Object.entries(clfData.devices || {})) {
      if (!clfActive.has(clf)) continue;
      if (devName) (deviceClfMap[devName] = deviceClfMap[devName] || []).push(clf);
      else defaultClfs.push(clf);
    }
    for (const clf of clfActive) {
      if (!(clf in (clfData.devices || {}))) defaultClfs.push(clf);
    }

    if (!devData.devices.length) {
      panel.innerHTML = '<div class="empty">No audio input devices found. Check that a microphone is connected.</div>';
      return;
    }

    const locOptions = micsData.length
      ? '<option value="">No location</option>' + micsData.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('')
      : null;

    panel.innerHTML = `<div class="device-grid">${devData.devices.map(d => {
      const key = d.is_default ? 'default' : `src_${d.index}`;
      const pip = pipelines[key];
      const isRunning = pip && pip.state !== 'idle';
      const safeLabel = (d.label || d.name).replace(/'/g, '');
      const hz = (d.sample_rate / 1000).toFixed(1);
      const stateTag = d.state === 'RUNNING' ? '<span style="color:var(--primary)">● active</span>'
                     : d.state === 'SUSPENDED' ? '<span style="color:var(--muted)">○ suspended</span>'
                     : '';
      const assignedLoc = deviceLocs[key] || '';
      const clfList = d.is_default
        ? [...(deviceClfMap[d.name] || []), ...defaultClfs]
        : (deviceClfMap[d.name] || []);
      const clfTags = clfList.map(clf => {
        const meta = CLASSIFIERS.find(c => c.key === clf);
        return meta ? `<span class="clf-tag clf-${clf}">${meta.icon} ${meta.label}</span>` : '';
      }).join('');
      const locSelector = locOptions
        ? `<select class="device-loc-select" title="Monitoring location" onchange="_saveDeviceLoc('${key}',this.value)">${locOptions.replace(`value="${escHtml(assignedLoc)}"`, `value="${escHtml(assignedLoc)}" selected`)}</select>`
        : '';
      return `
        <div class="device-row ${isRunning ? 'running' : ''}">
          <div class="device-info">
            <div class="device-name">${d.is_default ? '★ ' : ''}${d.label || d.name}${schedTag}${clfTags}</div>
            <div class="device-meta">${d.channels}ch · ${hz}kHz${stateTag ? ' · ' : ''}${stateTag}</div>
          </div>
          ${locSelector}
          <div class="device-status ${isRunning ? 'running' : 'idle'}">
            ${isRunning ? `● ${pip.state} — ${pip.window || ''}` : '○ Idle'}
          </div>
          <div class="device-actions">
            ${isRunning
              ? `<button class="btn btn-sm btn-danger" onclick="stopDevice('${key}', this)">■ Stop</button>`
              : `<select id="mode-${d.index}">
                   <option value="wake">Listen now</option>
                   <option value="schedule">Schedule</option>
                 </select>
                 <input type="number" placeholder="∞ min" min="1" max="1440"
                   style="width:70px;padding:5px 8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:0.78rem"
                   id="dur-${d.index}">
                 <button class="btn btn-sm btn-primary"
                   onclick="startDevice('${key}','${safeLabel}',${d.index},this)">▶ Start</button>`
            }
          </div>
        </div>`;
    }).join('')}</div>`;
  } catch (err) {
    panel.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`;
  }
}

function _micKey(name) {
  return 'mic_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
}

function _refreshMicLocationPanel(panel, mics, statusData, schedData) {
  const titleEl = document.getElementById('device-panel-title');
  if (titleEl) titleEl.textContent = 'Recording Locations';

  const pipelines = statusData.pipelines || {};
  const schedWindows = schedData.windows || [];
  const activeWin = schedWindows.find(w => w.active) || null;
  const schedTag = activeWin
    ? `<span class="sched-tag sched-active">${activeWin.name.replace(/_/g, ' ')}</span>`
    : '';

  const rows = mics.map(mic => {
    const key = _micKey(mic.name);
    const pip = pipelines[key];
    const isRunning = pip && pip.state !== 'idle';
    const clfs = (mic.classifiers || []).map(clf => {
      const m = CLASSIFIERS.find(c => c.key === clf);
      return m ? `<span class="clf-tag clf-${clf}">${m.icon} ${m.label}</span>` : '';
    }).join('');
    const deviceLabel = mic.device
      ? `<span style="font-size:0.72rem;color:var(--muted);font-family:var(--mono)">${escHtml(mic.device.split('.').slice(-2).join('…'))}</span>`
      : `<span style="font-size:0.72rem;color:var(--warning)">No device assigned — configure in Schedule</span>`;
    const stateLabel = isRunning
      ? `<span style="color:var(--primary)">● ${pip.state}${pip.window ? ' — ' + pip.window : ''}</span>`
      : `<span style="color:var(--muted)">○ Idle</span>`;
    const actionBtn = isRunning
      ? `<button class="btn btn-sm btn-danger" onclick="_stopMicByKey('${escHtml(key)}',this)">■ Stop</button>`
      : `<button class="btn btn-sm btn-primary" onclick="_startOneMic(this)">▶ Start</button>`;

    return `
      <div class="device-row ${isRunning ? 'running' : ''}">
        <div class="device-info">
          <div class="device-name">${escHtml(mic.name)}${schedTag}${clfs}</div>
          <div class="device-meta" style="margin-top:3px">${deviceLabel}</div>
          <div class="device-meta">${stateLabel}</div>
        </div>
        <div class="device-actions">${actionBtn}</div>
      </div>`;
  }).join('');

  panel.innerHTML = `<div class="device-grid">${rows}</div>
    <div class="btn-group" style="margin-top:12px">
      <button class="btn btn-primary btn-sm" onclick="_startAllMics()">▶ Start All</button>
      <button class="btn btn-outline btn-sm" onclick="_stopAllMics()">■ Stop All</button>
    </div>`;
}

async function _stopMicByKey(micKey, btn) {
  btnLoad(btn, '⟳');
  try {
    await api.post(`/api/pipeline/stop?device_key=${encodeURIComponent(micKey)}`);
    await pollStatus();
  } catch (err) {
    toast(err.message, 'error', 5000);
    btnDone(btn);
  }
}

async function _startOneMic(btn) {
  btnLoad(btn, '⟳');
  try {
    const result = await api.post('/api/pipeline/start_mics?mode=schedule');
    if (result.started.length) toast(`Started: ${result.started.join(', ')}`, 'success', 4000);
    await pollStatus();
  } catch (err) {
    toast(err.message, 'error', 5000);
    btnDone(btn);
  }
}

function _loadDeviceLocs() {
  try { return JSON.parse(localStorage.getItem('base-device-locs') || '{}'); }
  catch { return {}; }
}

function _saveDeviceLoc(key, loc) {
  const locs = _loadDeviceLocs();
  if (loc) locs[key] = loc; else delete locs[key];
  localStorage.setItem('base-device-locs', JSON.stringify(locs));
}

async function startDevice(deviceKey, deviceName, deviceIndex, btn) {
  const modeEl = document.getElementById(`mode-${deviceIndex}`);
  const durEl = document.getElementById(`dur-${deviceIndex}`);
  const mode = modeEl ? modeEl.value : 'wake';
  const dur = durEl ? parseInt(durEl.value) || null : null;
  btnLoad(btn, '⟳');
  try {
    // device_index null = use system default (correct routing via PipeWire)
    const params = new URLSearchParams({ device_key: deviceKey, device_name: deviceName });
    if (deviceIndex !== null) params.set('device_index', deviceIndex);
    if (mode === 'wake') {
      if (dur) params.set('duration_minutes', dur);
      await api.post(`/api/pipeline/wake?${params}`);
    } else {
      await api.post(`/api/pipeline/schedule?${params}`);
    }
    toast(`Started — ${deviceName}`, 'success', 5000);
    await pollStatus();
    _syncSpecToRunningDevice();
  } catch (err) {
    toast(err.message, 'error', 6000);
    btnDone(btn);
  }
}

async function stopDevice(deviceKey, btn) {
  btnLoad(btn, '⟳');
  try {
    await api.post(`/api/pipeline/stop?device_key=${deviceKey}`);
    toast('Device stopped', 'warn', 5000);
    await pollStatus();
  } catch (err) {
    toast(err.message, 'error', 6000);
    btnDone(btn);
  }
}

let _vuResetTimer = null;

function updateVuMeter(db) {
  const bar = document.getElementById('vu-bar');
  const label = document.getElementById('vu-db');
  if (!bar || !label) return;
  // Map -60dB→0% to 0dB→100%
  const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  bar.style.width = pct + '%';
  bar.className = 'vu-bar' + (pct > 85 ? ' high' : pct > 65 ? ' mid' : '');
  label.textContent = db.toFixed(1) + ' dB';
  // Reset to "no signal" if no update arrives within 3 seconds
  if (_vuResetTimer) clearTimeout(_vuResetTimer);
  _vuResetTimer = setTimeout(resetVuMeter, 3000);
}

function resetVuMeter() {
  if (_vuResetTimer) { clearTimeout(_vuResetTimer); _vuResetTimer = null; }
  const bar = document.getElementById('vu-bar');
  const label = document.getElementById('vu-db');
  if (!bar || !label) return;
  bar.style.width = '0%';
  bar.className = 'vu-bar';
  label.innerHTML = '<span class="vu-no-signal">no signal</span>';
}

function prependDetection(det) {
  const feed = document.getElementById('live-feed');
  if (!feed) return;
  if (state.classifierFilter !== 'all' && det.classifier !== state.classifierFilter) return;
  feed.insertAdjacentHTML('afterbegin', detectionCard(det));
  while (feed.children.length > MAX_FEED_ITEMS) feed.lastChild.remove();
}

function confClass(c) { return c >= 0.75 ? 'conf-high' : c >= 0.5 ? 'conf-mid' : 'conf-low'; }

/* ── Species gallery ── */

// Credits cache: filename → { author, license, license_url, source_url }
let _galleryCredits = {};
let _galleryMinConf = 0;   // 0–1 fraction; persists across live updates and re-renders

function _galleryFilterLabel(pct) {
  return pct === 0 ? 'Any' : `${pct}%+`;
}

async function _loadGalleryCredits() {
  try {
    const data = await api.get('/api/gallery');
    _galleryCredits = {};
    for (const img of data.images) _galleryCredits[img.filename] = img;
  } catch (_) {}
}

function _galleryItemId(species) {
  return 'gi_' + species.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
}

function _speciesKey(name) {
  // Matches the Python normalize() and JS must stay in sync.
  // Apostrophes are stripped so "Roesel's" → "roesels" not "roesel_s".
  return name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
}

function _speciesImageUrl(name) {
  return `/species_images/${_speciesKey(name)}.jpg`;
}

function _creditLine(name) {
  const key  = _speciesKey(name);
  const info = _galleryCredits[key + '.jpg'] || _galleryCredits[key + '.png'] || null;
  if (!info || !info.author || info.author === 'Unknown') return '';
  const text = info.license ? `© ${info.author} / ${info.license}` : `© ${info.author}`;
  return info.source_url
    ? `<a class="gallery-credit" href="${info.source_url}" target="_blank" rel="noopener">${text}</a>`
    : `<span class="gallery-credit">${text}</span>`;
}

function _fmtSeen(date, time) {
  const timeStr = time ? time.slice(0, 5) : '';
  const today = new Date().toISOString().slice(0, 10);
  if (!date || date === today) return timeStr;
  const d = new Date(date + 'T' + time);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${mon} ${timeStr}`;
}

function galleryCard(entry) {
  const { det, count, bestConf, firstSeen, lastSeen } = entry;
  const pct = Math.round(bestConf * 100);
  const idx = det.activity_index != null ? det.activity_index : null;
  const clf = CLASSIFIERS.find(c => c.key === det.classifier);
  const icon = clf ? clf.icon : '◈';
  const key = _speciesKey(det.species_common);
  const hasImage = !!(
    _galleryCredits[key + '.jpg'] ||
    _galleryCredits[key + '.png'] ||
    _galleryCredits[key + '.webp']
  );
  const uploadBtn = hasImage ? '' : `
    <label class="gallery-upload-btn" title="Upload a photo for ${det.species_common}">
      + Add photo
      <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none"
             onchange="_uploadFromCard('${key}', this)">
    </label>`;
  return `
    <div class="gallery-item" id="${_galleryItemId(det.species_common)}">
      <div class="gallery-img-wrap">
        <img src="${_speciesImageUrl(det.species_common)}"
             onerror="this.onerror=null;this.src='/species_images/_placeholder.svg';this.classList.add('gallery-placeholder')"
             loading="lazy" alt="${det.species_common}">
        <span class="gallery-count">×${count}</span>
        ${uploadBtn}
        ${_creditLine(det.species_common)}
      </div>
      <div class="gallery-info">
        <div class="gallery-name">${det.species_common}</div>
        <div class="gallery-sci">${det.species_scientific || ''}</div>
        <div class="gallery-meta">
          <span class="classifier-badge">${icon} ${det.classifier}</span>
          <span class="conf ${confClass(bestConf)}">${idx != null ? `${idx}/50` : `${pct}%`}</span>
        </div>
        <div class="gallery-times">
          <span title="First detected">⬆ ${firstSeen ? _fmtSeen(firstSeen.date, firstSeen.time) : '—'}</span>
          <span title="Last detected">⬇ ${lastSeen  ? _fmtSeen(lastSeen.date,  lastSeen.time)  : '—'}</span>
        </div>
      </div>
    </div>`;
}

async function _uploadFromCard(key, input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const r = await fetch(`/api/gallery/${key}/image`, { method: 'POST', body: formData });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.detail || `Upload failed (${r.status})`); }
    await _loadGalleryCredits();
    _populateGalleryGrid();
    toast('Photo added', 'success', 4000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renderGallery() {
  const confPct = Math.round(_galleryMinConf * 100);
  document.getElementById('main').innerHTML = `
    <div class="card">
      <div class="gallery-header">
        <div class="card-title" style="margin:0">Species Gallery</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="gallery-hint" id="gallery-count"></span>
          <div class="gallery-filter">
            <span class="gallery-filter-label">Min confidence: <strong id="gallery-conf-label">${_galleryFilterLabel(confPct)}</strong></span>
            <input type="range" class="gallery-conf-slider" id="gallery-conf-slider"
              min="0" max="95" step="5" value="${confPct}"
              oninput="
                _galleryMinConf = this.value / 100;
                document.getElementById('gallery-conf-label').textContent = _galleryFilterLabel(+this.value);
                _populateGalleryGrid();
              ">
          </div>
          <button class="btn btn-sm btn-outline" onclick="renderGalleryManage()">⚙ Manage Images</button>
        </div>
      </div>
      <div class="gallery-grid" id="gallery-grid"></div>
    </div>
  `;
  await _loadGalleryCredits();
  _populateGalleryGrid();
}

function _populateGalleryGrid() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;
  const all = Object.values(state.gallery);
  const entries = all
    .filter(e => e.bestConf >= _galleryMinConf)
    .sort((a, b) => (b.lastSeenTs || 0) - (a.lastSeenTs || 0));

  const countEl = document.getElementById('gallery-count');
  if (countEl) {
    if (!all.length) {
      countEl.textContent = 'No species detected yet';
    } else if (entries.length === all.length) {
      countEl.textContent = `${all.length} species this session`;
    } else {
      countEl.textContent = `${entries.length} of ${all.length} species`;
    }
  }

  if (!entries.length) {
    grid.innerHTML = all.length
      ? '<div class="empty" style="padding:24px 0">No species above the confidence threshold — try lowering the filter.</div>'
      : '<div class="empty" style="padding:24px 0">No species detected yet this session — start a recording to see species appear here.</div>';
    return;
  }
  grid.innerHTML = entries.map(e => galleryCard(e)).join('');
}

function updateGallery(det) {
  const key = det.species_common;
  const existing = state.gallery[key];
  const ts = new Date(det.date + 'T' + det.time).getTime();
  if (!existing) {
    state.gallery[key] = {
      det, count: 1, bestConf: det.confidence,
      firstSeen: { date: det.date, time: det.time },
      lastSeen:  { date: det.date, time: det.time },
      lastSeenTs: ts,
    };
  } else {
    existing.count++;
    if (det.confidence > existing.bestConf) existing.bestConf = det.confidence;
    existing.lastSeen  = { date: det.date, time: det.time };
    existing.lastSeenTs = ts;
  }
  _populateGalleryGrid();
}

/* ── Gallery image management ── */
async function renderGalleryManage() {
  document.getElementById('main').innerHTML = `
    <div class="card">
      <div class="gallery-header">
        <div class="card-title" style="margin:0">Manage Gallery Images</div>
        <button class="btn btn-sm btn-outline" onclick="renderGallery()">← Back to Gallery</button>
      </div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        Upload your own photos to personalise the gallery for your monitoring location.
        Edit author and licence fields to reflect the correct attribution for each image.
        Stock images are sourced from Wikimedia Commons under Creative Commons licences.
      </p>
      <div id="manage-table"><div class="empty">Loading...</div></div>
    </div>
  `;
  await _loadGalleryCredits();
  await _renderManageTable();
}

async function _renderManageTable() {
  const container = document.getElementById('manage-table');
  if (!container) return;
  let data;
  try {
    data = await api.get('/api/gallery');
  } catch (err) {
    container.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`;
    return;
  }
  if (!data.images.length) {
    container.innerHTML = '<div class="empty">No images installed yet.</div>';
    return;
  }
  container.innerHTML = `
    <table class="manage-table">
      <thead>
        <tr>
          <th style="width:72px">Photo</th>
          <th>Species</th>
          <th>Author / Photographer</th>
          <th>Licence</th>
          <th style="width:140px">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${data.images.map(img => _manageRow(img)).join('')}
      </tbody>
    </table>`;
}

function _manageRow(img) {
  const key = img.key;
  const author  = (img.author      || '').replace(/"/g, '&quot;');
  const license = (img.license     || '').replace(/"/g, '&quot;');
  const licUrl  = (img.license_url || '').replace(/"/g, '&quot;');
  const srcUrl  = (img.source_url  || '').replace(/"/g, '&quot;');
  const displayName = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `
    <tr id="mrow-${key}">
      <td>
        <img src="${img.url}" class="manage-thumb"
             onerror="this.src='/species_images/_placeholder.svg';this.style.opacity='0.4'"
             id="mthumb-${key}">
      </td>
      <td>
        <div style="font-weight:600;font-size:0.85rem">${displayName}</div>
        <div style="font-size:0.72rem;color:var(--muted);font-family:var(--mono)">${img.filename}</div>
        ${srcUrl ? `<a href="${srcUrl}" target="_blank" rel="noopener" style="font-size:0.7rem;color:var(--primary)">View source ↗</a>` : ''}
      </td>
      <td>
        <input class="manage-input" type="text" id="author-${key}"
               value="${author}" placeholder="Photographer name">
      </td>
      <td>
        <input class="manage-input" type="text" id="license-${key}"
               value="${license}" placeholder="e.g. CC BY-SA 4.0" style="width:120px">
        <input class="manage-input" type="text" id="licurl-${key}"
               value="${licUrl}" placeholder="Licence URL" style="width:100%;margin-top:4px">
      </td>
      <td>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn btn-sm btn-primary" onclick="_saveCredit('${key}', this)">Save</button>
          <label class="btn btn-sm btn-outline" style="cursor:pointer;text-align:center">
            Upload photo
            <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none"
                   onchange="_uploadImage('${key}', this)">
          </label>
        </div>
      </td>
    </tr>`;
}

async function _saveCredit(key, btn) {
  btnLoad(btn, '⟳');
  const author      = document.getElementById(`author-${key}`)?.value  || '';
  const license     = document.getElementById(`license-${key}`)?.value || '';
  const license_url = document.getElementById(`licurl-${key}`)?.value  || '';
  const source_url  = _galleryCredits[key + '.jpg']?.source_url || _galleryCredits[key + '.png']?.source_url || '';
  try {
    await api._request(`/api/gallery/${key}/credits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, license, license_url, source_url }),
    });
    _galleryCredits[key + '.jpg'] = { author, license, license_url, source_url };
    toast('Credit saved', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  btnDone(btn);
}

async function _uploadImage(key, input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const r = await fetch(`/api/gallery/${key}/image`, { method: 'POST', body: formData });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.detail || `Upload failed (${r.status})`); }
    const result = await r.json();
    // Refresh thumbnail with cache-busting
    const thumb = document.getElementById(`mthumb-${key}`);
    if (thumb) thumb.src = result.url + '?t=' + Date.now();
    toast('Image uploaded — credits updated to reflect your own photograph', 'success', 5000);
    // Pre-fill author with location name if credits are empty
    const authorEl = document.getElementById(`author-${key}`);
    if (authorEl && !authorEl.value) authorEl.value = 'Own photograph';
    const licenseEl = document.getElementById(`license-${key}`);
    if (licenseEl && !licenseEl.value) licenseEl.value = 'All rights reserved';
  } catch (err) {
    toast(err.message, 'error');
  }
}

function ukDate(iso) {
  // Convert YYYY-MM-DD → DD/MM/YYYY
  if (!iso || iso.length < 10) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function detectionCard(det) {
  const pct = Math.round(det.confidence * 100);
  const classifierInfo = CLASSIFIERS.find(c => c.key === det.classifier);
  const icon = classifierInfo ? classifierInfo.icon : '◈';
  const locLabel = det.location_name || det.site_name || '';
  const locTag = locLabel ? `<span class="classifier-badge" style="color:var(--accent)">${locLabel}</span>` : '';
  return `
    <div class="detection-card">
      <span class="classifier-badge">${icon} ${det.classifier}</span>
      <div class="det-body">
        <div class="det-top">
          <span class="species">${det.species_common}</span>
          ${locTag}
        </div>
        <div class="det-bottom">
          <span class="scientific">${det.species_scientific || ''}</span>
          <span class="det-meta">
            <span class="conf ${confClass(det.confidence)}">${pct}%</span>
            <span class="time">${det.time}</span>
          </span>
        </div>
      </div>
    </div>`;
}

/* ─────────────────────────── SCHEDULE ─────────────────────────── */
async function renderSchedule() {
  document.getElementById('main').innerHTML = `
    <div class="card">
      <div class="card-title">Today's Listening Windows ${helpBtn('schedule')}</div>
      <div id="schedule-table"><div class="empty">Loading...</div></div>
    </div>
    <div class="card">
      <div class="card-title">Add Custom Window</div>
      <div class="form-row">
        <div class="form-group"><label>Name</label><input type="text" id="w-name" placeholder="my_window"></div>
        <div class="form-group"><label>Anchor</label>
          <select id="w-anchor">
            <option value="sunrise">Sunrise</option><option value="sunset">Sunset</option>
            <option value="noon">Noon</option><option value="fixed">Fixed time</option>
          </select>
        </div>
        <div class="form-group"><label>Offset (min)</label><input type="number" id="w-offset" value="0" style="width:90px"></div>
        <div class="form-group"><label>Duration (min)</label><input type="number" id="w-duration" value="60" style="width:90px"></div>
        <div class="form-group" id="fixed-time-group" style="display:none"><label>Fixed time (HH:MM)</label><input type="text" id="w-fixed" placeholder="23:00"></div>
        <div class="form-group" style="justify-content:flex-end"><button class="btn btn-primary" id="btn-add-window">Add Window</button></div>
      </div>
    </div>
  `;
  document.getElementById('w-anchor').addEventListener('change', e =>
    document.getElementById('fixed-time-group').style.display = e.target.value === 'fixed' ? '' : 'none'
  );
  document.getElementById('btn-add-window').addEventListener('click', addWindow);
  await loadSchedule();
}

const _CLF_META = {
  bird:   { icon: '🐦', label: 'Birds',    note: 'Standard microphone (48kHz)' },
  bat:    { icon: '🦇', label: 'Bats',     note: 'Requires ultrasonic mic (≥192kHz)' },
  bee:    { icon: '🐝', label: 'Bees',     note: 'Standard microphone (16kHz) — BuzzDetect v1.0.1' },
  insect: { icon: '🦗', label: 'Insects',  note: 'Standard microphone (44.1kHz) — grasshoppers, bush crickets' },
  soil:   { icon: '🌱', label: 'Soil',     note: 'Surface / contact microphone (22kHz) — Soil Acoustic Index (beta)' },
  water:  { icon: '💧', label: 'Water',    note: 'Submersible hydrophone (44.1kHz) — Water Acoustic Index (beta)' },
};

async function loadClassifierDevices() {
  const panel = document.getElementById('classifier-device-panel');
  if (!panel) return;
  try {
    const [clfData, devData] = await Promise.all([
      api.get('/api/settings/classifiers'),
      api.get('/api/devices'),
    ]);

    const deviceOptions = (selected) => {
      const none = `<option value="" ${!selected ? 'selected' : ''}>System default</option>`;
      const opts = devData.devices.map(d =>
        `<option value="${d.name}" ${selected === d.name ? 'selected' : ''}>${d.label || d.name}</option>`
      ).join('');
      return none + opts;
    };

    panel.innerHTML = ['bird', 'bat', 'bee', 'insect', 'soil', 'water'].map(key => {
      const meta = _CLF_META[key];
      const isActive = clfData.active.includes(key);
      const assignedDevice = clfData.devices[key];
      return `
        <div class="device-row" style="margin-bottom:6px" id="clf-row-${key}">
          <div class="device-info">
            <div class="device-name">${meta.icon} ${meta.label}</div>
            <div class="device-meta">${meta.note}</div>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--muted);cursor:pointer">
            <input type="checkbox" id="clf-active-${key}" ${isActive ? 'checked' : ''}
              style="accent-color:var(--primary);width:16px;height:16px">
            Active
          </label>
          <div class="form-group" style="margin:0">
            <label style="font-size:0.72rem">Microphone</label>
            <select id="clf-device-${key}" style="min-width:200px">
              ${deviceOptions(assignedDevice)}
            </select>
          </div>
        </div>`;
    }).join('');

    // Auto-save on any change so the YAML always matches the UI — otherwise
    // users uncheck a classifier, never click Save, and the next Listen Now
    // re-spins up the unwanted classifier from stale config.
    panel.querySelectorAll('input[id^="clf-active-"], select[id^="clf-device-"]')
      .forEach(el => el.addEventListener('change', saveClassifiers));
  } catch (err) {
    panel.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`;
  }
}

async function saveClassifiers() {
  const btn = document.getElementById('btn-save-classifiers');
  if (btn) btnLoad(btn, '⟳ Saving...');
  const active = ['bird', 'bat', 'bee', 'insect', 'soil', 'water'].filter(k =>
    document.getElementById(`clf-active-${k}`)?.checked
  );
  const devices = {};
  for (const key of ['bird', 'bat', 'bee', 'insect', 'soil', 'water']) {
    const val = document.getElementById(`clf-device-${key}`)?.value;
    devices[key] = val === '' ? null : val;
  }
  try {
    await api.post('/api/settings/classifiers', { active, devices });
    toast('Classifier settings saved — applies on next Listen Now', 'success', 4000);
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { if (btn) btnDone(btn); }
}

async function loadMicClfPanel() {
  const panel = document.getElementById('mic-clf-panel');
  if (!panel) return;
  try {
    const [mics, devData, status] = await Promise.all([
      api.get('/api/settings/mics').catch(() => []),
      api.get('/api/devices').catch(() => ({ devices: [] })),
      api.get('/api/status').catch(() => ({ pipelines: {} })),
    ]);

    if (!mics.length) {
      panel.innerHTML = '<div class="empty">No monitoring locations configured yet — add them under Settings → Monitoring Locations.</div>';
      return;
    }

    const pipelines = status.pipelines || {};
    const deviceCount = devData.devices.length;
    const deviceNote = devData.note || '';
    const deviceOpts = devData.devices.map(d =>
      `<option value="${escHtml(d.name)}">${escHtml(d.label || d.name)}${d.is_default ? ' ★' : ''}</option>`
    ).join('');
    // Build a lookup of device sample_rate by name so we can warn when a
    // standard-rate mic is assigned to bat (needs ≥192 kHz for ultrasonic)
    const deviceRateMap = {};
    for (const d of devData.devices) deviceRateMap[d.name] = d.sample_rate || 0;

    const deviceBanner = deviceNote
      ? `<p style="font-size:0.78rem;color:var(--warning);margin:0 0 12px;padding:8px 10px;background:rgba(210,153,34,0.10);border-radius:var(--radius)">
           ⚠ ${escHtml(deviceNote)}
           <button class="btn btn-sm btn-outline" style="margin-left:10px;font-size:0.72rem" onclick="loadMicClfPanel()">↺ Refresh</button>
         </p>`
      : `<p style="font-size:0.75rem;color:var(--muted);margin:0 0 10px">${deviceCount} microphone${deviceCount !== 1 ? 's' : ''} detected
           <button class="btn btn-sm btn-outline" style="margin-left:8px;font-size:0.72rem" onclick="loadMicClfPanel()">↺ Refresh</button>
         </p>`;

    panel.innerHTML = deviceBanner + mics.map((mic, idx) => {
      const micKey = 'mic_' + mic.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');
      const pip = pipelines[micKey];
      const isRunning = pip && pip.state !== 'idle';
      const activeClfs = mic.classifiers || [];
      const schedule = mic.schedule || 'auto';

      const deviceSel = `<select class="mic-device-sel" data-idx="${idx}" style="font-size:0.78rem;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);min-width:180px">
        <option value="">System default</option>${deviceOpts}
      </select>`;

      const clfBoxes = ['bird','bat','bee','insect','soil','water'].map(clf => {
        const m = _CLF_META[clf];
        const checked = activeClfs.includes(clf) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:4px;font-size:0.78rem;cursor:pointer;white-space:nowrap">
          <input type="checkbox" class="mic-clf-check" data-idx="${idx}" data-clf="${clf}" ${checked}
            style="accent-color:var(--primary);width:14px;height:14px">
          ${m.icon} ${m.label}
        </label>`;
      }).join('');

      const schedSel = `<select class="mic-sched-sel" data-idx="${idx}" style="font-size:0.78rem;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
        <option value="auto" ${schedule === 'auto' ? 'selected' : ''}>Auto (schedule)</option>
        <option value="manual" ${schedule === 'manual' ? 'selected' : ''}>Manual only</option>
      </select>`;

      const stateLabel = isRunning
        ? `<span style="color:var(--primary);font-size:0.75rem">● ${pip.state}${pip.window ? ' — ' + pip.window : ''}</span>`
        : `<span style="color:var(--muted);font-size:0.75rem">○ Idle</span>`;

      const actionBtn = isRunning
        ? `<button class="btn btn-sm btn-danger" onclick="_stopMic('${escHtml(micKey)}',this)">■ Stop</button>`
        : `<button class="btn btn-sm btn-primary" data-mic-name="${escHtml(mic.name)}" onclick="_startMic(this)">▶ Start</button>`;

      // Warn if bat is selected but the assigned device is a standard-rate mic
      const deviceRate = deviceRateMap[mic.device] || 0;
      const batWarning = activeClfs.includes('bat') && mic.device && deviceRate > 0 && deviceRate <= 48000
        ? `<div style="width:100%;font-size:0.75rem;color:var(--danger);padding:5px 8px;background:rgba(220,50,50,0.08);border-radius:var(--radius);margin-top:2px">
             ⚠ Bat detection needs an ultrasonic mic (≥192 kHz). This device captures ${Math.round(deviceRate/1000)} kHz — bat calls will not be detected and false positives are likely. Assign the AudioMoth instead.
           </div>`
        : '';

      return `
        <div class="device-row" id="mic-row-${idx}" style="flex-wrap:wrap;gap:10px;margin-bottom:8px;${isRunning ? 'border-color:var(--primary)' : ''}">
          <div class="device-info" style="min-width:120px">
            <div class="device-name">${escHtml(mic.name)}</div>
            <div class="device-meta" style="margin-top:4px">${stateLabel}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:180px">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Microphone</div>
            ${deviceSel}
            ${batWarning}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Detect</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">${clfBoxes}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Schedule</div>
            ${schedSel}
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
            ${actionBtn}
          </div>
        </div>`;
    }).join('') + `
      <div class="btn-group" style="margin-top:12px">
        <button class="btn btn-primary" id="btn-start-all-mics">▶ Start All</button>
        <button class="btn btn-outline" id="btn-stop-all-mics">■ Stop All</button>
      </div>`;

    // Restore selected device values (set after innerHTML so options exist)
    mics.forEach((mic, idx) => {
      const sel = panel.querySelector(`.mic-device-sel[data-idx="${idx}"]`);
      if (sel && mic.device) sel.value = mic.device;
    });

    // Auto-save on any change
    panel.querySelectorAll('.mic-device-sel, .mic-sched-sel').forEach(el =>
      el.addEventListener('change', () => _saveMicConfig(parseInt(el.dataset.idx)))
    );
    panel.querySelectorAll('.mic-clf-check').forEach(el =>
      el.addEventListener('change', () => _saveMicConfig(parseInt(el.dataset.idx)))
    );
    document.getElementById('btn-start-all-mics')?.addEventListener('click', _startAllMics);
    document.getElementById('btn-stop-all-mics')?.addEventListener('click', _stopAllMics);

  } catch (err) {
    panel.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`;
  }
}

async function _saveMicConfig(idx) {
  const panel = document.getElementById('mic-clf-panel');
  if (!panel) return;
  const device = panel.querySelector(`.mic-device-sel[data-idx="${idx}"]`)?.value || null;
  const schedule = panel.querySelector(`.mic-sched-sel[data-idx="${idx}"]`)?.value || 'auto';
  const classifiers = [...panel.querySelectorAll(`.mic-clf-check[data-idx="${idx}"]:checked`)]
    .map(el => el.dataset.clf);
  try {
    await api.patch(`/api/settings/mics/${idx}`, { device: device || null, classifiers, schedule });
    _populateSpecDevices();
  } catch (err) {
    toast(err.message, 'error', 4000);
  }
}

async function _startMic(btn) {
  const micName = btn.dataset.micName || '';
  btnLoad(btn, '⟳');
  try {
    const url = micName
      ? `/api/pipeline/start_mics?name=${encodeURIComponent(micName)}`
      : '/api/pipeline/start_mics';
    const result = await api.post(url);
    const msg = result.started.length
      ? `Started: ${result.started.join(', ')}`
      : result.skipped.length ? 'No classifiers configured for this location' : 'Already running';
    toast(msg, result.started.length ? 'success' : 'warn', 4000);
    await pollStatus();
    await loadMicClfPanel();
  } catch (err) {
    toast(err.message, 'error', 6000);
    btnDone(btn);
  }
}

async function _stopMic(micKey, btn) {
  btnLoad(btn, '⟳');
  try {
    await api.post(`/api/pipeline/stop?device_key=${encodeURIComponent(micKey)}`);
    toast('Stopped', 'success', 3000);
    await pollStatus();
    await loadMicClfPanel();
  } catch (err) {
    toast(err.message, 'error', 6000);
    btnDone(btn);
  }
}

async function _startAllMics() {
  const btn = document.getElementById('btn-start-all-mics');
  btnLoad(btn, '⟳ Starting…');
  try {
    const result = await api.post('/api/pipeline/start_mics');
    const msg = result.started.length
      ? `Started: ${result.started.join(', ')}`
      : result.skipped.length ? 'No locations have classifiers configured' : 'All already running';
    toast(msg, result.started.length ? 'success' : 'warn', 5000);
    await pollStatus();
    await loadMicClfPanel();
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { btnDone(btn); }
}

async function _stopAllMics() {
  const btn = document.getElementById('btn-stop-all-mics');
  btnLoad(btn, '⟳');
  try {
    await api.post('/api/pipeline/stop_all');
    toast('All recordings stopped', 'warn', 4000);
    await pollStatus();
    await loadMicClfPanel();
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { btnDone(btn); }
}

async function loadSchedule() {
  const el = document.getElementById('schedule-table');
  if (!el) return;
  try {
    const data = await api.get('/api/schedule');
    if (!data.windows.length) { el.innerHTML = '<div class="empty">No windows configured.</div>'; return; }
    el.innerHTML = `
      <table>
        <thead><tr><th>Window</th><th>Start</th><th>End</th><th>Duration</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.windows.map(w => {
          const actionBtn = w.editable
            ? `<button class="btn btn-sm btn-danger" onclick="deleteWindow('${escHtml(w.name)}')">Remove</button>`
            : `<button class="btn btn-sm btn-outline" onclick="_editWindow(this,'${escHtml(w.name)}',${w.offset_mins},${w.duration_mins},'${escHtml(w.anchor)}')">Edit</button>`;
          return `<tr class="${w.active ? 'active-row' : ''}" id="sched-row-${escHtml(w.name)}">
            <td>${escHtml(w.name)}</td><td class="window-time">${w.start}</td>
            <td class="window-time">${w.end}</td><td>${w.duration_mins} min</td>
            <td>${w.active ? '<span class="badge-active">● ACTIVE</span>' : ''}</td>
            <td>${actionBtn}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
  } catch (err) { el.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`; }
}

function _editWindow(btn, name, offsetMins, durationMins, anchor) {
  const row = document.getElementById(`sched-row-${name}`);
  if (!row) return;
  const anchorLabels = { sunrise: 'Sunrise', sunset: 'Sunset', noon: 'Noon', fixed: 'Fixed' };
  row.insertAdjacentHTML('afterend', `
    <tr id="sched-edit-${name}" style="background:var(--surface2)">
      <td colspan="6" style="padding:10px 12px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:0.8rem;color:var(--muted)">Anchor: <strong>${escHtml(anchorLabels[anchor] || anchor)}</strong></span>
          <label style="font-size:0.82rem;display:flex;align-items:center;gap:6px">
            Offset (min)
            <input type="number" id="edit-offset-${name}" value="${offsetMins}" style="width:80px;padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
          </label>
          <label style="font-size:0.82rem;display:flex;align-items:center;gap:6px">
            Duration (min)
            <input type="number" id="edit-dur-${name}" value="${durationMins}" style="width:80px;padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text)">
          </label>
          <button class="btn btn-sm btn-primary" onclick="_saveWindow('${escHtml(name)}')">Save</button>
          <button class="btn btn-sm btn-outline" onclick="document.getElementById('sched-edit-${escHtml(name)}').remove()">Cancel</button>
        </div>
        <div style="font-size:0.73rem;color:var(--muted);margin-top:6px">Offset is relative to ${escHtml(anchorLabels[anchor] || anchor).toLowerCase()} — negative = before, positive = after.</div>
      </td>
    </tr>`);
  btn.disabled = true;
}

async function _saveWindow(name) {
  const offset_mins = parseInt(document.getElementById(`edit-offset-${name}`)?.value) || 0;
  const duration_mins = parseInt(document.getElementById(`edit-dur-${name}`)?.value);
  if (!duration_mins || duration_mins < 1) { toast('Duration must be at least 1 minute', 'warn'); return; }
  try {
    await api.patch(`/api/schedule/windows/${encodeURIComponent(name)}`, { offset_mins, duration_mins });
    toast(`'${name}' updated`, 'success');
    await loadSchedule();
  } catch (err) { toast(err.message, 'error', 6000); }
}

async function addWindow() {
  const btn = document.getElementById('btn-add-window');
  const name = document.getElementById('w-name').value.trim();
  const anchor = document.getElementById('w-anchor').value;
  const offset_mins = parseInt(document.getElementById('w-offset').value) || 0;
  const duration_mins = parseInt(document.getElementById('w-duration').value);
  const fixed_time = anchor === 'fixed' ? document.getElementById('w-fixed').value.trim() : null;
  if (!name) { toast('Window name is required', 'warn'); return; }
  if (!duration_mins) { toast('Duration is required', 'warn'); return; }
  btnLoad(btn, '⟳ Adding...');
  try {
    await api.post('/api/schedule/windows', { name, anchor, offset_mins, duration_mins, fixed_time });
    toast(`Window '${name}' added`, 'success');
    document.getElementById('w-name').value = '';
    await loadSchedule();
  } catch (err) { toast(err.message, 'error', 6000); } finally { btnDone(btn); }
}

async function deleteWindow(name) {
  try {
    await api.del(`/api/schedule/windows/${name}`);
    toast(`Window '${name}' removed`, 'warn');
    await loadSchedule();
  } catch (err) { toast(err.message, 'error', 6000); }
}

/* ─────────────────────────── CLIPS ─────────────────────────── */
async function renderClips() {
  document.getElementById('main').innerHTML = `
    <div class="card" style="flex:1">
      <div class="card-title">Audio Clip Library ${helpBtn('clips')}</div>
      <div class="tabs" id="clips-tabs">
        ${CLASSIFIERS.map(c => `<button class="tab ${c.key === 'all' ? 'active' : ''}"
          onclick="filterClips('${c.key}', this)">${c.icon} ${c.label}</button>`).join('')}
      </div>
      <div class="clips-layout">
        <div>
          <div class="card-title">Species</div>
          <div class="species-list" id="species-list"><div class="empty">Loading...</div></div>
        </div>
        <div>
          <div class="card-title" id="clips-title">Select a species</div>
          <div class="clips-grid" id="clips-grid"><div class="empty">Select a species to browse clips.</div></div>
        </div>
      </div>
    </div>
  `;
  await loadSpeciesList('all');
}

async function loadSpeciesList(classifierFilter = 'all') {
  const el = document.getElementById('species-list');
  if (!el) return;
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const data = await api.get('/api/clips');   // always fetch all; group client-side
    if (!data.species.length) {
      el.innerHTML = '<div class="empty">No clips recorded yet.</div>';
      return;
    }

    if (classifierFilter !== 'all') {
      // Filtered view — flat list for selected type
      const filtered = data.species.filter(s => s.classifier === classifierFilter);
      if (!filtered.length) {
        el.innerHTML = `<div class="empty">No ${classifierFilter} clips recorded yet.</div>`;
        return;
      }
      el.innerHTML = filtered.map(s => speciesItem(s)).join('');
      return;
    }

    // All view — group by classifier type with headers
    const groups = {};
    CLASSIFIERS.filter(c => c.key !== 'all').forEach(c => { groups[c.key] = []; });
    data.species.forEach(s => {
      const key = s.classifier || 'bird';
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });

    let html = '';
    CLASSIFIERS.filter(c => c.key !== 'all').forEach(c => {
      const items = groups[c.key] || [];
      if (!items.length) return;
      html += `<div class="species-group-header">${c.icon} ${c.label}</div>`;
      html += items.map(s => speciesItem(s)).join('');
    });
    el.innerHTML = html || '<div class="empty">No clips recorded yet.</div>';
  } catch (err) { el.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`; }
}

function speciesItem(s) {
  return `<div class="species-item" data-dir="${s.dir}" data-name="${s.name.replace(/"/g, '&quot;')}" onclick="loadClips(this.dataset.dir, this.dataset.name)">
    <span>${s.name}</span><span class="count">${s.clip_count}</span>
  </div>`;
}

function filterClips(key, btn) {
  document.querySelectorAll('#clips-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadSpeciesList(key);
}

async function loadClips(dir, name) {
  document.querySelectorAll('.species-item').forEach(el =>
    el.classList.toggle('active', el.dataset.dir === dir)
  );
  document.getElementById('clips-title').textContent = name;
  const grid = document.getElementById('clips-grid');
  grid.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const data = await api.get(`/api/clips/${dir}`);
    if (!data.clips.length) { grid.innerHTML = '<div class="empty">No clips for this species.</div>'; return; }
    const encodedDir = encodeURIComponent(dir);
    grid.innerHTML = data.clips.map(c => {
      const batNote = c.sample_rate > 48000
        ? `<br><span style="font-size:0.7rem;color:var(--muted)">🦇 ${(c.sample_rate/1000).toFixed(0)}kHz → pitched down for playback</span>`
        : '';
      return `<div class="clip-row">
        <div class="clip-meta">${ukDate(c.date)} ${c.time}<br><span class="conf ${confClass(c.confidence)}">${Math.round(c.confidence * 100)}% conf</span>${batNote}</div>
        <audio controls src="${c.url}" preload="none"></audio>
        <a class="btn btn-sm btn-outline" href="${c.download_url}" download title="Download original WAV">↓</a>
        <button class="btn btn-sm btn-danger" onclick="deleteClip('${encodedDir}','${encodeURIComponent(c.filename)}',this)">✕</button>
      </div>`;
    }).join('');
  } catch (err) { grid.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`; }
}

async function deleteClip(dir, filename, btn) {
  btnLoad(btn, '...');
  try {
    await api.del(`/api/clips/${dir}/${filename}`);
    btn.closest('.clip-row').remove();
    toast('Clip deleted', 'warn');
  } catch (err) { toast(err.message, 'error', 6000); btnDone(btn); }
}

/* ─────────────────────────── REPORTS ─────────────────────────── */
async function renderReports() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const typeOptions = CLASSIFIERS.map(c =>
    `<option value="${c.key}">${c.icon} ${c.label}</option>`
  ).join('');

  document.getElementById('main').innerHTML = `
    <div class="card">
      <div class="card-title">Filters</div>
      <div class="form-row" style="align-items:flex-end">
        <div class="form-group">
          <label>From</label>
          <input type="date" id="r-from" lang="en-GB" value="${weekAgo}">
        </div>
        <div class="form-group">
          <label>To</label>
          <input type="date" id="r-to" lang="en-GB" value="${today}">
        </div>
        <div class="form-group">
          <label>Type</label>
          <select id="r-type">${typeOptions}</select>
        </div>
        <div class="form-group">
          <label>Species</label>
          <select id="r-species" style="min-width:180px"><option value="">All species</option></select>
        </div>
        <div class="form-group">
          <label>Location</label>
          <select id="r-location" style="min-width:160px"><option value="">All locations</option></select>
        </div>
        <div class="form-group" style="justify-content:flex-end">
          <button class="btn btn-primary" id="btn-load-report">Load Report</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Summary ${helpBtn('reports')}</div>
      <div id="report-content"><div class="empty">Select filters and click Load Report.</div></div>
    </div>

    <div class="card">
      <div class="card-title">Activity Heatmaps ${helpBtn('heatmap')}</div>
      <div id="heatmap-section"><div class="heatmap-empty">Load a report above to generate heatmaps.</div></div>
    </div>

    <div class="card">
      <div class="card-title">Download</div>
      <div class="download-row">
        <button class="btn btn-outline" id="btn-dl-detections">⬇ Detections CSV</button>
        <button class="btn btn-outline" id="btn-dl-sessions">⬇ Sessions CSV</button>
      </div>
      <p style="font-size:0.75rem;color:var(--muted);margin-top:10px">
        All fields included. Respects date range, type, species, and location filters.
      </p>
    </div>

    <div class="card">
      <div class="card-title" style="color:var(--danger)">Danger Zone</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px">
        Permanently deletes all detection and session log files. This cannot be undone.
      </p>
      <button class="btn btn-danger" id="btn-clear-logs">🗑 Clear All Logs</button>
    </div>
  `;

  document.getElementById('btn-load-report').addEventListener('click', loadReport);
  document.getElementById('btn-dl-detections').addEventListener('click', () => downloadReport('detections'));
  document.getElementById('btn-dl-sessions').addEventListener('click', () => downloadReport('sessions'));
  document.getElementById('btn-clear-logs').addEventListener('click', confirmClearLogs);
  document.getElementById('r-type').addEventListener('change', refreshReportSpecies);

  await Promise.all([refreshReportSpecies(), refreshReportLocations()]);
  loadReport();
}

async function refreshReportSpecies() {
  const typeEl = document.getElementById('r-type');
  const speciesEl = document.getElementById('r-species');
  if (!typeEl || !speciesEl) return;
  const classifier = typeEl.value === 'all' ? '' : typeEl.value;
  const url = classifier ? `/api/reports/species?classifier=${classifier}` : '/api/reports/species';
  try {
    const data = await api.get(url);
    speciesEl.innerHTML = '<option value="">All species</option>' +
      data.species.map(s => `<option value="${s}">${s}</option>`).join('');
  } catch (_) {}
}

async function refreshReportLocations() {
  const el = document.getElementById('r-location');
  if (!el) return;
  try {
    const data = await api.get('/api/reports/locations');
    el.innerHTML = '<option value="">All locations</option>' +
      data.locations.map(l => `<option value="${escHtml(l)}">${escHtml(l)}</option>`).join('');
  } catch (_) {}
}

async function loadReport() {
  const btn = document.getElementById('btn-load-report');
  const fromEl = document.getElementById('r-from');
  const el = document.getElementById('report-content');
  if (!el || !fromEl) return;   // navigated away before load fired
  const from = fromEl.value;
  const to = document.getElementById('r-to').value;
  const classifier = document.getElementById('r-type')?.value || 'all';
  const species = document.getElementById('r-species')?.value || '';
  el.innerHTML = '<div class="empty">Loading...</div>';
  if (btn) btnLoad(btn, '⟳ Loading...');
  const location = document.getElementById('r-location')?.value || '';
  const classifierParam = classifier && classifier !== 'all' ? `&classifier=${classifier}` : '';
  const speciesParam = species ? `&species=${encodeURIComponent(species)}` : '';
  const locationParam = location ? `&location=${encodeURIComponent(location)}` : '';
  try {
    const data = await api.get(`/api/reports/summary?date_from=${from}&date_to=${to}${classifierParam}${speciesParam}${locationParam}`);
    const filterLabel = data.species ? ` — ${data.species}` : '';
    if (!data.days.length) { el.innerHTML = `<div class="empty">No data for this period${filterLabel}.</div>`; return; }
    el.innerHTML = `
      ${data.species ? `<p style="font-size:0.82rem;color:var(--accent);margin-bottom:12px">Filtered: ${data.species}</p>` : ''}
      ${location ? `<p style="font-size:0.82rem;color:var(--accent);margin-bottom:12px">Location: ${escHtml(location)}</p>` : ''}
      <div class="grid-2" style="margin-bottom:16px">
        <div class="stat"><div class="value">${data.totals.sessions}</div><div class="label">Sessions</div></div>
        <div class="stat"><div class="value">${data.totals.total_calls}</div><div class="label">Total calls</div></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Sessions</th>${data.species ? '' : '<th>Species</th>'}<th>Total Calls</th></tr></thead>
        <tbody>${data.days.map(d => `
          <tr><td class="window-time">${ukDate(d.date)}</td><td>${d.sessions}</td>${data.species ? '' : `<td>${d.species_count}</td>`}<td>${d.total_calls}</td></tr>`).join('')}
        </tbody>
      </table>`;
    // Load heatmaps in parallel
    loadHeatmaps(from, to, classifierParam.replace('&classifier=',''), locationParam.replace('&location=',''));
  } catch (err) {
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">${err.message}</div>`;
    toast(err.message, 'error', 6000);
  } finally { if (btn) btnDone(btn); }
}

async function loadHeatmaps(from, to, classifier, location) {
  const el = document.getElementById('heatmap-section');
  if (!el) return;
  el.innerHTML = '<div class="heatmap-empty">Loading heatmaps…</div>';
  try {
    let url = `/api/reports/heatmap?date_from=${from}&date_to=${to}`;
    if (classifier) url += `&classifier=${classifier}`;
    if (location) url += `&location=${encodeURIComponent(location)}`;
    const data = await api.get(url);
    const species = Object.keys(data.by_hour);
    if (!species.length) { el.innerHTML = '<div class="heatmap-empty">No data to display.</div>'; return; }

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;flex-wrap:wrap">
        <div>
          <div class="heatmap-title">Time of Day</div>
          <div class="heatmap-wrap" id="hm-hour"></div>
        </div>
        <div>
          <div class="heatmap-title">Month of Year</div>
          <div class="heatmap-wrap" id="hm-month"></div>
        </div>
      </div>
      <div class="heatmap-legend">
        <span>Fewer</span><div class="heatmap-legend-bar"></div><span>More detections</span>
      </div>`;

    renderHeatmap('hm-hour', species, data.by_hour,
      Array.from({length:24}, (_,i) => `${String(i).padStart(2,'0')}:00`));

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    renderHeatmap('hm-month', species, data.by_month, MONTHS);
  } catch (err) {
    el.innerHTML = `<div class="heatmap-empty" style="color:var(--danger)">${err.message}</div>`;
  }
}

function renderHeatmap(containerId, species, data, colLabels) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const nCols = colLabels.length;

  // Compute global max for colour scaling
  let maxVal = 1;
  species.forEach(s => { data[s].forEach(v => { if (v > maxVal) maxVal = v; }); });

  const cellToColor = (v) => {
    if (!v) return 'var(--surface2)';
    const intensity = v / maxVal;
    const l = Math.round(16 + intensity * 38);  // 16% (dim) → 54% (bright)
    return `hsl(71, 82%, ${l}%)`;
  };

  // Build grid: label col + nCols data cols
  const gridCols = `120px repeat(${nCols}, 22px)`;
  let html = `<div class="heatmap-grid" style="display:grid;grid-template-columns:${gridCols};gap:1px">`;

  // Header row
  html += `<div></div>`;
  colLabels.forEach((lbl, i) => {
    const show = nCols <= 12 || i % 3 === 0;
    html += `<div class="heatmap-col-header">${show ? lbl : ''}</div>`;
  });

  // Data rows
  species.forEach(s => {
    const label = s.length > 18 ? s.slice(0, 17) + '…' : s;
    html += `<div class="heatmap-label" title="${s}">${label}</div>`;
    data[s].forEach((v, i) => {
      html += `<div class="heatmap-cell" style="background:${cellToColor(v)}"
        title="${s} · ${colLabels[i]}: ${v} detection${v !== 1 ? 's' : ''}"></div>`;
    });
  });

  html += '</div>';
  el.innerHTML = html;
}

function downloadReport(type) {
  const from = document.getElementById('r-from')?.value || '';
  const to = document.getElementById('r-to')?.value || '';
  const classifier = document.getElementById('r-type')?.value || 'all';
  const species = document.getElementById('r-species')?.value || '';
  const location = document.getElementById('r-location')?.value || '';
  let url = `/api/reports/download/${type}?date_from=${from}&date_to=${to}`;
  if (classifier && classifier !== 'all') url += `&classifier=${classifier}`;
  if (species) url += `&species=${encodeURIComponent(species)}`;
  if (location) url += `&location=${encodeURIComponent(location)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function confirmClearLogs() {
  const confirmed = window.confirm(
    'Are you sure you want to delete ALL detection and session logs?\n\nThis cannot be undone.'
  );
  if (!confirmed) return;
  const btn = document.getElementById('btn-clear-logs');
  btnLoad(btn, '⟳ Clearing...');
  try {
    const result = await api.del('/api/reports/logs');
    toast(`Logs cleared: ${result.cleared.join(', ') || 'nothing to delete'}`, 'warn', 6000);
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { btnDone(btn); }
}

/* ─────────────────────────── SETTINGS ─────────────────────────── */
/* ── Analytics Dashboard ── */

let _analyticsChart = null;
let _analyticsMap   = null;

async function renderAnalytics() {
  const main = document.getElementById('main');
  const today = new Date();
  const d30 = new Date(today); d30.setDate(today.getDate() - 29);
  const fmt = d => d.toISOString().slice(0, 10);
  const dflt_from = fmt(d30);
  const dflt_to   = fmt(today);

  main.innerHTML = `
    <div class="card an-filters">
      <div class="an-filter-row">
        <div class="an-filter-group">
          <label class="an-label">Date range</label>
          <div style="display:flex;align-items:center;gap:6px">
            <input type="date" id="an-from" class="form-input an-date" value="${dflt_from}">
            <span style="color:var(--muted);font-size:0.8rem">–</span>
            <input type="date" id="an-to" class="form-input an-date" value="${dflt_to}">
          </div>
        </div>

        <div class="an-filter-group">
          <label class="an-label">Locations <span class="an-hint">(ctrl+click to multi-select)</span></label>
          <select id="an-locations" multiple class="an-multi"></select>
        </div>

        <div class="an-filter-group">
          <label class="an-label">Classifiers <span class="an-hint">(ctrl+click to multi-select)</span></label>
          <select id="an-taxa" multiple class="an-multi"></select>
        </div>

        <div class="an-filter-group" style="min-width:160px">
          <label class="an-label">Min confidence — <span id="an-conf-val" style="color:var(--primary)">0%</span></label>
          <input type="range" id="an-conf" min="0" max="1" step="0.05" value="0"
            oninput="document.getElementById('an-conf-val').textContent=Math.round(this.value*100)+'%'"
            style="width:100%;accent-color:var(--primary);margin-top:6px">
        </div>

        <div class="an-filter-group" style="justify-content:flex-end;flex-direction:row;align-items:flex-end;gap:16px;flex:0 0 auto">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--muted);cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="an-weather" style="accent-color:var(--primary);width:15px;height:15px" checked>
            Weather overlay
          </label>
          <button class="btn btn-primary" onclick="loadAnalytics()">Load</button>
        </div>
      </div>
    </div>

    <div id="an-stats" class="an-stats-row"></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Activity over time</div>
      <div style="position:relative;height:260px">
        <canvas id="an-chart"></canvas>
      </div>
      <div id="an-chart-legend" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:0.78rem"></div>
    </div>

    <div class="an-bottom-grid">
      <div class="card">
        <div class="card-title">Monitoring locations</div>
        <div id="an-map" style="height:340px;border-radius:var(--radius);overflow:hidden;background:var(--surface2)"></div>
      </div>
      <div class="card">
        <div class="card-title">Species activity</div>
        <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:0 8px;font-size:0.7rem;color:var(--muted);padding:0 0 6px;border-bottom:1px solid var(--border);margin-bottom:4px">
          <span>Species</span><span style="text-align:right">Count</span><span style="text-align:right">vs prev</span><span style="text-align:right">Conf</span>
        </div>
        <div id="an-species" style="max-height:306px;overflow-y:auto"></div>
      </div>
    </div>
  `;

  // Populate filter dropdowns
  try {
    const [locs] = await Promise.all([
      api.get('/api/reports/locations').catch(() => ({ locations: [] })),
    ]);
    const locSel = document.getElementById('an-locations');
    (locs.locations || []).forEach(l => {
      const o = document.createElement('option'); o.value = l; o.textContent = l; locSel.appendChild(o);
    });
    const taxaSel = document.getElementById('an-taxa');
    ['bird', 'bat', 'bee', 'insect', 'soil', 'water'].forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c.charAt(0).toUpperCase() + c.slice(1); taxaSel.appendChild(o);
    });
  } catch (e) { /* ignore */ }

  loadAnalytics();
}

function _anFilters() {
  const locSel  = document.getElementById('an-locations');
  const taxaSel = document.getElementById('an-taxa');
  const selVals = sel => Array.from(sel?.selectedOptions || []).map(o => o.value).filter(Boolean);
  return {
    date_from:  document.getElementById('an-from')?.value || '',
    date_to:    document.getElementById('an-to')?.value || '',
    locations:  selVals(locSel).join(','),
    classifiers: selVals(taxaSel).join(','),
    confidence: parseFloat(document.getElementById('an-conf')?.value || '0'),
    weather:    document.getElementById('an-weather')?.checked ?? true,
  };
}

async function loadAnalytics() {
  const f = _anFilters();
  const q = `date_from=${f.date_from}&date_to=${f.date_to}&locations=${encodeURIComponent(f.locations)}&classifiers=${encodeURIComponent(f.classifiers)}&confidence=${f.confidence}`;

  try {
    const [stats, activity, species, locs] = await Promise.all([
      api.get(`/api/analytics/stats?${q}`),
      api.get(`/api/analytics/activity?${q}`),
      api.get(`/api/analytics/species?${q}`),
      api.get('/api/analytics/locations'),
    ]);

    _renderAnStats(stats);
    await _renderAnChart(activity, f);
    _renderAnSpecies(species);
    _renderAnMap(locs);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

function _renderAnStats(stats) {
  const el = document.getElementById('an-stats');
  if (!el) return;
  const card = (label, value, sub) => `
    <div class="card" style="text-align:center;padding:16px 12px">
      <div style="font-size:1.8rem;font-weight:700;color:var(--primary)">${value}</div>
      <div style="font-size:0.78rem;color:var(--muted);margin-top:2px">${label}</div>
      ${sub ? `<div style="font-size:0.7rem;color:var(--muted);margin-top:4px">${sub}</div>` : ''}
    </div>`;
  el.innerHTML =
    card('Detections', stats.total_detections.toLocaleString()) +
    card('Species', stats.species_count) +
    card('Sessions', stats.session_count) +
    card('Active days', stats.active_days, `${stats.date_from} – ${stats.date_to}`);
}

const _CLASSIFIER_COLORS = {
  bird:   '#90b20c', bat: '#c084fc', bee: '#f5c842',
  insect: '#ff8c42', soil: '#c2956a', water: '#42b4f5', unknown: '#888',
};

async function _renderAnChart(activity, filters) {
  const canvas = document.getElementById('an-chart');
  if (!canvas) return;

  if (_analyticsChart) { _analyticsChart.destroy(); _analyticsChart = null; }

  const dates = activity.dates || [];
  const classifiers = activity.classifiers || [];

  // Build datasets: one per classifier
  const datasets = classifiers.map(clf => ({
    label: clf.charAt(0).toUpperCase() + clf.slice(1),
    data: dates.map(d => (activity.current[d]?.[clf] || 0)),
    borderColor: _CLASSIFIER_COLORS[clf] || '#888',
    backgroundColor: (_CLASSIFIER_COLORS[clf] || '#888') + '22',
    fill: true,
    tension: 0.3,
    pointRadius: dates.length > 60 ? 0 : 3,
  }));

  // Weather overlay (temperature + precipitation)
  let weatherData = null;
  if (filters.weather && filters.date_from && filters.date_to) {
    try {
      const lat = 51.8403, lon = -1.3625;
      const wUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${filters.date_from}&end_date=${filters.date_to}&daily=temperature_2m_max,precipitation_sum,windspeed_10m_max&timezone=Europe%2FLondon`;
      const wr = await fetch(wUrl);
      if (wr.ok) weatherData = await wr.json();
    } catch { /* weather is optional */ }
  }

  if (weatherData?.daily) {
    const wDates  = weatherData.daily.time || [];
    const wTemps  = weatherData.daily.temperature_2m_max || [];
    const wRain   = weatherData.daily.precipitation_sum || [];
    datasets.push({
      label: 'Temp °C',
      data: dates.map(d => { const i = wDates.indexOf(d); return i >= 0 ? wTemps[i] : null; }),
      borderColor: '#d4a843',
      borderDash: [4, 3],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      yAxisID: 'y2',
    });
    datasets.push({
      label: 'Rain mm',
      data: dates.map(d => { const i = wDates.indexOf(d); return i >= 0 ? wRain[i] : null; }),
      borderColor: '#5ba4d4',
      backgroundColor: '#5ba4d422',
      fill: true,
      tension: 0.2,
      pointRadius: 0,
      yAxisID: 'y3',
      type: 'bar',
    });
  }

  _analyticsChart = new Chart(canvas, {
    type: 'line',
    data: { labels: dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y ?? '—'}` } },
      },
      scales: {
        x: {
          ticks: { color: 'var(--muted)', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: 'rgba(144,178,12,0.10)' },
        },
        y: {
          position: 'left',
          ticks: { color: 'var(--muted)' },
          grid: { color: 'rgba(144,178,12,0.10)' },
          title: { display: true, text: 'Detections', color: 'var(--muted)', font: { size: 11 } },
        },
        y2: {
          position: 'right',
          display: weatherData != null,
          ticks: { color: '#d4a843' },
          grid: { drawOnChartArea: false },
          title: { display: weatherData != null, text: 'Temp °C', color: '#d4a843', font: { size: 11 } },
        },
        y3: {
          position: 'right',
          display: false,
          min: 0,
        },
      },
    },
  });

  // Custom legend
  const legend = document.getElementById('an-chart-legend');
  if (legend) {
    legend.innerHTML = datasets.map(ds => `
      <span style="display:flex;align-items:center;gap:4px">
        <span style="display:inline-block;width:14px;height:3px;background:${ds.borderColor};border-radius:2px"></span>
        <span style="color:var(--muted)">${ds.label}</span>
      </span>`).join('');
  }
}

function _renderAnSpecies(data) {
  const el = document.getElementById('an-species');
  if (!el) return;
  const species = data.species || [];
  if (!species.length) { el.innerHTML = '<div class="empty">No detections in selected period</div>'; return; }

  el.innerHTML = species.map(s => {
    const trend = s.trend_pct;
    const trendStr = s.prev_count
      ? `<span style="color:${trend >= 0 ? 'var(--primary)' : 'var(--danger)'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(0)}%</span>`
      : '<span style="color:var(--muted);font-size:0.7rem">new</span>';
    const conf = s.avg_confidence ? `${(s.avg_confidence * 100).toFixed(0)}%` : '—';
    const clrDot = _CLASSIFIER_COLORS[s.classifier] || '#888';
    return `<div style="display:grid;grid-template-columns:8px 1fr auto auto auto;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${clrDot}"></span>
      <span style="font-size:0.83rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(s.species)}">${escHtml(s.species)}</span>
      <span style="font-size:0.8rem;color:var(--muted);text-align:right">${s.count.toLocaleString()}</span>
      <span style="font-size:0.75rem;text-align:right;min-width:48px">${trendStr}</span>
      <span style="font-size:0.72rem;color:var(--muted);text-align:right;min-width:34px">${conf}</span>
    </div>`;
  }).join('');
}

function _renderAnMap(locsData) {
  const container = document.getElementById('an-map');
  if (!container) return;

  const locs = locsData.locations || [];
  const site = locsData.site || {};

  if (_analyticsMap) { _analyticsMap.remove(); _analyticsMap = null; }

  const siteLat = site.latitude || 51.8403;
  const siteLon = site.longitude || -1.3625;

  _analyticsMap = L.map('an-map', { zoomControl: true, attributionControl: true })
    .setView([siteLat, siteLon], 15);

  // CartoDB Dark Matter — free, no API key, works offline once cached
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" style="color:#90b20c">OpenStreetMap</a> © <a href="https://carto.com/attributions" style="color:#90b20c">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(_analyticsMap);

  const maxDet = Math.max(1, ...locs.map(l => l.detections));
  const bounds = [];

  locs.forEach(loc => {
    if (!loc.latitude || !loc.longitude) return;
    bounds.push([loc.latitude, loc.longitude]);
    const r = 9 + Math.round((loc.detections / maxDet) * 14);
    const clfs = (loc.classifiers || []).join(', ') || 'none';
    const col = _CLASSIFIER_COLORS[loc.classifiers?.[0]] || '#90b20c';
    const noDevice = !loc.has_device;
    const marker = L.circleMarker([loc.latitude, loc.longitude], {
      radius: r,
      color: col,
      fillColor: col,
      fillOpacity: noDevice ? 0.2 : 0.65,
      weight: 2,
    }).addTo(_analyticsMap);

    const badge = noDevice ? '<br><em style="color:#f59e0b;font-size:0.78em">No device assigned</em>' : '';
    marker.bindPopup(
      `<strong style="color:#90b20c">${escHtml(loc.name)}</strong><br>
       <span style="font-size:0.82em;color:#a0b8a8">Classifiers: ${escHtml(clfs)}</span><br>
       <span style="font-size:0.82em">Detections: <strong>${loc.detections.toLocaleString()}</strong></span>${badge}`,
      { maxWidth: 220 }
    );

    // Permanent label below marker
    L.marker([loc.latitude, loc.longitude], {
      icon: L.divIcon({
        className: '',
        html: `<div class="an-map-label">${escHtml(loc.name)}</div>`,
        iconAnchor: [0, -r - 4],
      }),
      interactive: false,
    }).addTo(_analyticsMap);
  });

  // Fit to markers if we have any; otherwise stay on site centre
  if (bounds.length > 1) {
    _analyticsMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  } else if (bounds.length === 1) {
    _analyticsMap.setView(bounds[0], 16);
  }
}

window.loadAnalytics = loadAnalytics;

async function renderSettings() {
  document.getElementById('main').innerHTML = `
    <div class="card">
      <div class="card-title">System</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        Control whether BASE starts automatically when this device powers on.
        Enable this on any deployment device so recording resumes after a reboot or power cut.
      </p>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.9rem">
          <div class="boot-toggle" id="boot-toggle" onclick="toggleBoot()" role="switch" aria-checked="false" tabindex="0">
            <div class="boot-toggle-knob"></div>
          </div>
          <span id="boot-toggle-label">Start on boot</span>
        </label>
        <span id="boot-status-chip" style="font-size:0.78rem;padding:3px 10px;border-radius:20px;background:var(--surface2);color:var(--muted)">Checking…</span>
      </div>
      <div id="boot-detail" style="margin-top:10px;font-size:0.78rem;color:var(--muted)"></div>
    </div>

    <div class="card">
      <div class="card-title">Site Name ${helpBtn('location')}</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        The name of this recording site. Appears in every detection record, CSV export, and MQTT payload as <code>site_name</code>.
        Distinct from individual Monitoring Locations (microphone positions) configured below.
      </p>
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>Site Name</label>
          <input type="text" id="loc-name" placeholder="e.g. Blenheim Palace" style="min-width:220px">
        </div>
        <div class="form-group">
          <label>Latitude</label>
          <input type="number" id="loc-lat" step="0.0001" placeholder="51.8403" style="width:120px">
        </div>
        <div class="form-group">
          <label>Longitude</label>
          <input type="number" id="loc-lon" step="0.0001" placeholder="-1.3625" style="width:120px">
        </div>
        <div class="form-group" style="justify-content:flex-end">
          <button class="btn btn-primary" id="btn-save-location">Save</button>
        </div>
      </div>
      <div id="location-status"></div>
    </div>

    <div class="card">
      <div class="card-title">MQTT Live Feed ${helpBtn('mqtt')}</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        Publish every detection as JSON to an MQTT broker in real time.
        Credentials are stored locally and never committed to git.
      </p>

      <div class="form-row" style="margin-bottom:16px;align-items:center;gap:20px">
        <label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer">
          <input type="checkbox" id="mqtt-enabled" style="accent-color:var(--primary);width:16px;height:16px">
          <span>Enable MQTT publishing</span>
        </label>
      </div>

      <div class="form-row" style="margin-bottom:16px">
        <div class="form-group">
          <label>Connection mode</label>
          <select id="mqtt-mode">
            <option value="direct">Direct — Python connects to broker (cloud/remote, with credentials)</option>
            <option value="bridge">Bridge — Python connects to local Mosquitto, which forwards upstream</option>
          </select>
        </div>
        <div class="form-group" style="flex:1">
          <label>Topic Prefix</label>
          <input type="text" id="mqtt-prefix" placeholder="bioacoustics">
        </div>
      </div>

      <div id="mqtt-direct-fields">
        <div class="form-row" style="margin-bottom:10px">
          <div class="form-group" style="flex:2">
            <label>Broker Host</label>
            <input type="text" id="mqtt-host" placeholder="hostname or IP">
          </div>
          <div class="form-group" style="width:110px">
            <label>Port</label>
            <input type="number" id="mqtt-port" placeholder="1883" style="width:90px">
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--muted);cursor:pointer;align-self:flex-end;padding-bottom:10px">
            <input type="checkbox" id="mqtt-tls" style="accent-color:var(--primary);width:14px;height:14px">
            TLS / SSL
          </label>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label>Username</label>
            <input type="text" id="mqtt-user" placeholder="optional" autocomplete="off">
          </div>
          <div class="form-group" style="flex:1">
            <label>Password</label>
            <input type="password" id="mqtt-pass" placeholder="leave blank to keep existing" autocomplete="new-password">
          </div>
          <div id="mqtt-pass-note" style="align-self:flex-end;padding-bottom:10px;font-size:0.73rem;color:var(--muted);white-space:nowrap"></div>
        </div>
      </div>

      <div id="mqtt-bridge-fields" style="display:none">
        <div class="form-row" style="margin-bottom:10px">
          <div class="form-group" style="flex:2">
            <label>Local Mosquitto Host</label>
            <input type="text" id="mqtt-bridge-host" value="localhost" placeholder="localhost">
          </div>
          <div class="form-group" style="width:110px">
            <label>Port</label>
            <input type="number" id="mqtt-bridge-port" value="1883" style="width:90px">
          </div>
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;font-size:0.78rem;color:var(--muted);line-height:1.6">
          <strong style="color:var(--text)">Mosquitto bridge setup</strong><br>
          Python connects to local Mosquitto — add a bridge config on the host machine to forward to your remote broker:<br>
          <code style="display:block;margin-top:6px;color:var(--accent);font-family:var(--mono)">/etc/mosquitto/conf.d/bridge.conf</code>
          Credentials for the remote broker go in that file only — not here.
          Run <code style="color:var(--accent);font-family:var(--mono)">sudo systemctl restart mosquitto</code> after editing.
        </div>
      </div>

      <div class="btn-group" style="margin-top:16px">
        <button class="btn btn-primary" id="btn-save-mqtt">Save</button>
        <button class="btn btn-outline" id="btn-test-mqtt">Test Connection</button>
      </div>
      <div id="mqtt-test-result" style="margin-top:10px;font-size:0.82rem"></div>
    </div>

    <div class="card">
      <div class="card-title">Monitoring Locations ${helpBtn('mics')}</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        Each microphone with a friendly name and coordinates. Broadcast to subscribers via MQTT so the live viewer can label detections and pinpoint mics on a map.
      </p>
      <div id="mics-rows"></div>
      <div id="mics-add-form" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Friendly name</label>
            <input type="text" id="mic-f-name" placeholder="e.g. Great Lake">
          </div>
          <div class="form-group">
            <label>Latitude</label>
            <input type="number" id="mic-f-lat" step="0.0001" placeholder="51.8403" style="width:120px">
          </div>
          <div class="form-group">
            <label>Longitude</label>
            <input type="number" id="mic-f-lon" step="0.0001" placeholder="-1.3625" style="width:120px">
          </div>
        </div>
        <div class="btn-group">
          <button class="btn btn-primary btn-sm" id="btn-confirm-mic">Add</button>
          <button class="btn btn-outline btn-sm" onclick="hideMicAddForm()">Cancel</button>
        </div>
      </div>
      <div class="btn-group" style="margin-top:14px">
        <button class="btn btn-outline btn-sm" id="btn-add-mic">+ Add location</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Auto-resume on Boot</div>
      <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">
        When enabled, recording resumes automatically after a reboot or power cut — no manual intervention needed.
        Disabled automatically when you click Stop.
      </p>
      <label style="display:flex;align-items:center;gap:10px;font-size:0.88rem;cursor:pointer">
        <input type="checkbox" id="autostart-enabled" style="accent-color:var(--primary);width:16px;height:16px">
        <span>Resume recording on boot</span>
      </label>
      <div class="btn-group" style="margin-top:14px">
        <button class="btn btn-primary btn-sm" id="btn-save-autostart">Save</button>
      </div>
    </div>

  `;

  // Load location
  try {
    const loc = await api.get('/api/settings/location');
    document.getElementById('loc-name').value = loc.name || '';
    document.getElementById('loc-lat').value = loc.latitude || '';
    document.getElementById('loc-lon').value = loc.longitude || '';
  } catch (err) { toast(err.message, 'error'); }

  // Load MQTT
  try {
    const m = await api.get('/api/settings/mqtt');
    document.getElementById('mqtt-enabled').checked = m.enabled;
    document.getElementById('mqtt-mode').value = m.mode || 'direct';
    document.getElementById('mqtt-prefix').value = m.topic_prefix || 'bioacoustics';
    document.getElementById('mqtt-host').value = m.host || '';
    document.getElementById('mqtt-port').value = m.port || 1883;
    document.getElementById('mqtt-tls').checked = m.tls || false;
    document.getElementById('mqtt-user').value = m.username || '';
    if (m.has_password) document.getElementById('mqtt-pass-note').textContent = '● password set';
    _mqttModeChanged(m.mode || 'direct');
  } catch (err) { toast(err.message, 'error'); }

  // Load mics — silently treat 404 as empty (older server without this route)
  try {
    renderMicsRows(await api.get('/api/settings/mics'));
  } catch { renderMicsRows([]); }

  // Load autostart
  try {
    const a = await api.get('/api/settings/autostart');
    document.getElementById('autostart-enabled').checked = !!a.enabled;
  } catch { /* non-fatal */ }

  // Load boot status
  _refreshBootStatus();

  document.getElementById('mqtt-mode').addEventListener('change', e => _mqttModeChanged(e.target.value));
  document.getElementById('btn-save-location').addEventListener('click', saveLocation);
  document.getElementById('btn-save-mqtt').addEventListener('click', saveMqtt);
  document.getElementById('btn-test-mqtt').addEventListener('click', testMqtt);
  document.getElementById('btn-add-mic').addEventListener('click', showMicAddForm);
  document.getElementById('btn-confirm-mic').addEventListener('click', confirmAddMic);
  document.getElementById('btn-save-autostart').addEventListener('click', saveAutostart);
}

async function saveAutostart() {
  const btn = document.getElementById('btn-save-autostart');
  btnLoad(btn, '⟳');
  try {
    await api.post('/api/settings/autostart', { enabled: document.getElementById('autostart-enabled').checked });
    toast('Auto-resume setting saved', 'success', 3000);
  } catch (err) {
    toast(err.message, 'error', 5000);
  } finally { btnDone(btn); }
}

function _mqttModeChanged(mode) {
  const isDirect = mode === 'direct';
  document.getElementById('mqtt-direct-fields').style.display = isDirect ? '' : 'none';
  document.getElementById('mqtt-bridge-fields').style.display = isDirect ? 'none' : '';
}

async function saveMqtt() {
  const btn = document.getElementById('btn-save-mqtt');
  const password = document.getElementById('mqtt-pass').value;
  btnLoad(btn, '⟳ Saving...');
  const mode = document.getElementById('mqtt-mode').value;
  const isBridge = mode === 'bridge';
  try {
    await api.post('/api/settings/mqtt', {
      enabled: document.getElementById('mqtt-enabled').checked,
      mode,
      host: isBridge
        ? (document.getElementById('mqtt-bridge-host').value.trim() || 'localhost')
        : document.getElementById('mqtt-host').value.trim(),
      port: isBridge
        ? (parseInt(document.getElementById('mqtt-bridge-port').value) || 1883)
        : (parseInt(document.getElementById('mqtt-port').value) || 1883),
      tls: isBridge ? false : document.getElementById('mqtt-tls').checked,
      topic_prefix: document.getElementById('mqtt-prefix').value.trim() || 'bioacoustics',
      username: isBridge ? null : (document.getElementById('mqtt-user').value.trim() || null),
      password: isBridge ? null : (password || null),
    });
    if (password) {
      document.getElementById('mqtt-pass').value = '';
      document.getElementById('mqtt-pass-note').textContent = '● password set';
    }
    toast('MQTT settings saved — restart pipeline to apply', 'success', 5000);
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { btnDone(btn); }
}

async function testMqtt() {
  const btn = document.getElementById('btn-test-mqtt');
  const result = document.getElementById('mqtt-test-result');
  btnLoad(btn, '⟳ Testing...');
  result.textContent = '';
  try {
    const data = await api.post('/api/settings/mqtt/test', {});
    if (data.connected) {
      result.style.color = 'var(--primary)';
      result.textContent = '✓ Connected successfully';
    } else {
      result.style.color = 'var(--danger)';
      result.textContent = `✗ ${data.error || 'Connection failed'}`;
    }
  } catch (err) {
    result.style.color = 'var(--danger)';
    result.textContent = `✗ ${err.message}`;
  } finally { btnDone(btn); }
}

async function saveLocation() {
  const btn = document.getElementById('btn-save-location');
  const name = document.getElementById('loc-name').value.trim();
  const latitude = parseFloat(document.getElementById('loc-lat').value);
  const longitude = parseFloat(document.getElementById('loc-lon').value);
  if (!name) { toast('Location name is required', 'warn'); return; }
  if (isNaN(latitude) || isNaN(longitude)) { toast('Valid latitude and longitude required', 'warn'); return; }
  btnLoad(btn, '⟳ Saving...');
  try {
    await api.post('/api/settings/location', { name, latitude, longitude });
    toast(`Location saved — ${name}`, 'success', 5000);
    document.getElementById('location-status').innerHTML =
      `<p style="font-size:0.78rem;color:var(--muted);margin-top:10px">Restart the pipeline to apply changes to the active session.</p>`;
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally { btnDone(btn); }
}

/* ── Mics (monitoring locations) ── */

function renderMicsRows(mics) {
  const el = document.getElementById('mics-rows');
  if (!el) return;
  if (!mics.length) {
    el.innerHTML = '<p style="font-size:0.82rem;color:var(--muted);margin-bottom:8px">No locations configured yet.</p>';
    return;
  }
  el.innerHTML = mics.map((m, i) => _micViewRow(m, i)).join('');
}

function _micViewRow(m, i) {
  return `
    <div class="device-row" id="mic-row-view-${i}" style="margin-bottom:6px">
      <div class="device-info">
        <div class="device-name">${escHtml(m.name)}</div>
        <div class="device-meta">${m.latitude}, ${m.longitude}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="showMicEditForm(${i})">Edit</button>
        <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteMicRow(${i})">Remove</button>
      </div>
    </div>
    <div id="mic-row-edit-${i}" style="display:none;margin-bottom:10px;padding:10px;background:var(--surface2);border-radius:var(--radius);border:1px solid var(--border)">
      <div class="form-row" style="margin-bottom:8px">
        <div class="form-group" style="flex:2;margin:0 6px 0 0">
          <label style="font-size:0.78rem">Name</label>
          <input type="text" id="mic-e-name-${i}" value="${escHtml(m.name)}" style="font-size:0.82rem;padding:5px 8px">
        </div>
        <div class="form-group" style="margin:0 6px 0 0">
          <label style="font-size:0.78rem">Latitude</label>
          <input type="number" id="mic-e-lat-${i}" value="${m.latitude}" step="0.0001" style="width:120px;font-size:0.82rem;padding:5px 8px">
        </div>
        <div class="form-group" style="margin:0">
          <label style="font-size:0.78rem">Longitude</label>
          <input type="number" id="mic-e-lon-${i}" value="${m.longitude}" step="0.0001" style="width:120px;font-size:0.82rem;padding:5px 8px">
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" id="mic-e-save-${i}" onclick="saveMicEdit(${i})">Save</button>
        <button class="btn btn-outline btn-sm" onclick="hideMicEditForm(${i})">Cancel</button>
      </div>
    </div>`;
}

function showMicEditForm(i) {
  document.getElementById(`mic-row-view-${i}`).style.display = 'none';
  document.getElementById(`mic-row-edit-${i}`).style.display = '';
  document.getElementById(`mic-e-name-${i}`).focus();
}

function hideMicEditForm(i) {
  document.getElementById(`mic-row-edit-${i}`).style.display = 'none';
  document.getElementById(`mic-row-view-${i}`).style.display = '';
}

async function saveMicEdit(i) {
  const name = document.getElementById(`mic-e-name-${i}`).value.trim();
  const lat  = parseFloat(document.getElementById(`mic-e-lat-${i}`).value);
  const lon  = parseFloat(document.getElementById(`mic-e-lon-${i}`).value);
  if (!name) { toast('Name is required', 'warn'); return; }
  if (isNaN(lat) || isNaN(lon)) { toast('Valid latitude and longitude required', 'warn'); return; }
  const btn = document.getElementById(`mic-e-save-${i}`);
  btnLoad(btn, '⟳');
  try {
    await api.patch(`/api/settings/mics/${i}`, { name, latitude: lat, longitude: lon });
    renderMicsRows(await api.get('/api/settings/mics'));
    toast('Location updated', 'success', 2000);
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'error', 5000);
    btnDone(btn);
  }
}

async function deleteMicRow(i) {
  try {
    const result = await api.del(`/api/settings/mics/${i}`);
    renderMicsRows(result.mics || []);
    toast('Location removed', 'success', 2000);
  } catch (err) {
    toast(`Could not remove: ${err.message}`, 'error', 5000);
  }
}

function showMicAddForm() {
  document.getElementById('mics-add-form').style.display = '';
  document.getElementById('btn-add-mic').style.display = 'none';
  document.getElementById('mic-f-name').focus();
}

function hideMicAddForm() {
  document.getElementById('mics-add-form').style.display = 'none';
  document.getElementById('btn-add-mic').style.display = '';
  ['mic-f-name','mic-f-lat','mic-f-lon'].forEach(id => {
    document.getElementById(id).value = '';
  });
}

async function confirmAddMic() {
  const name = document.getElementById('mic-f-name').value.trim();
  const lat  = parseFloat(document.getElementById('mic-f-lat').value);
  const lon  = parseFloat(document.getElementById('mic-f-lon').value);
  if (!name) { toast('Name is required', 'warn'); return; }
  if (isNaN(lat) || isNaN(lon)) { toast('Valid latitude and longitude required', 'warn'); return; }
  const btn = document.getElementById('btn-confirm-mic');
  btnLoad(btn, '⟳');
  try {
    const result = await api.post('/api/settings/mics', { name, latitude: lat, longitude: lon });
    hideMicAddForm();
    renderMicsRows(result.mics || []);
    toast('Location added', 'success', 2000);
  } catch (err) {
    toast(`Could not add: ${err.message}`, 'error', 5000);
  } finally {
    btnDone(btn);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Help system ── */
const HELP = {
  spectrogram: {
    icon: '🔬', title: 'Live Spectrogram',
    body: `<p>A spectrogram is a visual representation of sound — it shows <strong>which frequencies are present</strong> in the audio at each moment in time.</p>
    <p><strong>How to read it:</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li>The <strong>horizontal axis</strong> is time, scrolling left as new audio arrives on the right.</li>
      <li>The <strong>vertical axis</strong> is frequency — low sounds (bass, worms, wind) at the bottom, high sounds (birdsong, insects) at the top.</li>
      <li><strong>Colour</strong> indicates loudness: dark = quiet, bright green/yellow/red = loud.</li>
    </ul>
    <p>Bird calls appear as bright horizontal streaks in the 2–8 kHz band. The dawn chorus produces a spectacular burst of overlapping streaks. Bee buzzes appear as a diffuse band around 200–400 Hz. Soil activity appears as faint low-frequency texture near the bottom.</p>
    <p><em>Log scale</em> compresses the upper frequencies and expands the lower ones — useful for seeing soil and low-frequency signals that would otherwise be squeezed into a thin strip.</p>`
  },
  vu_meter: {
    icon: '🎙', title: 'Audio Level (VU Meter)',
    body: `<p>The bar shows the <strong>current volume level</strong> from the microphone in decibels (dB). It updates every second while the pipeline is listening.</p>
    <p><strong>What the numbers mean:</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>–60 dB or lower</strong> — near silence; the microphone is picking up very little.</li>
      <li><strong>–40 to –20 dB</strong> — typical ambient outdoor level; good for detection.</li>
      <li><strong>–10 dB or higher</strong> — loud sound nearby (close bird call, wind gust, handling noise).</li>
    </ul>
    <p>If the bar never moves, the microphone may not be capturing audio — check the device selection in Recording Devices.</p>`
  },
  live_detections: {
    icon: '◈', title: 'Live Detection Feed',
    body: `<p>Every time an AI classifier identifies a species with sufficient confidence, a detection card appears here in real time.</p>
    <p>Each card shows the <strong>species name</strong>, <strong>confidence score</strong> (how certain the model is), the <strong>classifier</strong> that made the identification (bird, bat, bee, etc.), and the <strong>time</strong> of the detection.</p>
    <p><strong>Confidence scores</strong> range from 0% to 100%. A score above ~70% is generally reliable; scores of 35–50% are possible matches worth noting but treated as lower confidence. The minimum threshold is set in Settings.</p>
    <p>Use the <strong>tabs</strong> (Birds, Bats, Bees…) to filter the feed by organism group.</p>`
  },
  schedule: {
    icon: '🕐', title: 'Listening Schedule',
    body: `<p>The schedule defines <strong>when BASE listens</strong>. Windows are defined relative to solar events at your location — sunrise, sunset, or noon — so the timing shifts automatically with the seasons without manual adjustment.</p>
    <p><strong>Default windows:</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>Dawn chorus</strong> — 30 minutes before sunrise. The most productive window for bird song; songbirds begin calling before light to establish territory.</li>
      <li><strong>Morning song</strong> — 90 minutes after sunrise. A secondary activity peak as birds resume feeding.</li>
      <li><strong>Dusk</strong> — 60 minutes before sunset. Evening song, roost calls, and bat emergence.</li>
    </ul>
    <p>You can add custom windows (e.g. a fixed midnight bat survey) using the form below. Adaptive windows are added automatically — for example, if an owl is detected, a night window is enabled.</p>`
  },
  classifiers: {
    icon: '🐦', title: 'Classifiers & Microphones',
    body: `<p>A <strong>classifier</strong> is an AI model trained to identify a specific group of organisms from audio. BASE runs multiple classifiers simultaneously, each tuned to a different frequency range and organism type.</p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>🐦 Birds</strong> — BirdNET (Cornell Lab). 6,000+ species, 48 kHz. Standard microphone.</li>
      <li><strong>🦇 Bats</strong> — BatDetect2 (Univ. Edinburgh). 17 UK species, 192+ kHz. Requires an <em>ultrasonic</em> microphone.</li>
      <li><strong>🐝 Bees</strong> — BuzzDetect v1.0.1 (OSU Bee Lab). Detects insect flight buzz at 16 kHz. Standard microphone.</li>
      <li><strong>🦗 Insects</strong> — OrthopterOSS (coming). Grasshoppers and bush crickets, 2–20 kHz.</li>
      <li><strong>🌱 Soil</strong> — Blenheim Innovation. Soil Acoustic Index (beta) — worm movement, root activity, 50–2000 Hz. Best with a contact/geophone microphone.</li>
      <li><strong>💧 Water</strong> — Blenheim Innovation. Water Acoustic Index (beta) — fish calls, invertebrate activity, 300–5000 Hz. Requires a submersible hydrophone.</li>
    </ul>
    <p>Each classifier can be assigned a <strong>different microphone</strong>. This means a bat ultrasonic mic and a standard bird mic can record simultaneously from different devices.</p>`
  },
  clips: {
    icon: '🎵', title: 'Audio Clip Library',
    body: `<p>BASE saves short WAV audio clips for each detected species, organised by type and species. These are the raw audio segments that triggered a detection.</p>
    <p>Clips let you <strong>verify detections by ear</strong> — listen to confirm that the model identified the sound correctly. This is especially useful for rare or unexpected species.</p>
    <p>The library applies smart retention: new species are always saved; common species clips are only kept if their confidence score exceeds a threshold, and the lowest-confidence clip is replaced when the per-species limit is reached. This prevents the disk filling with low-quality recordings of abundant species.</p>
    <p>Use the <strong>type tabs</strong> to browse by organism group, then click a species to see its clips.</p>`
  },
  reports: {
    icon: '📊', title: 'Reports',
    body: `<p>The Reports page lets you summarise, filter, and export detection data across any date range.</p>
    <p><strong>Filters:</strong> Narrow results by date range, organism type (Birds, Bats, Bees…), and individual species. Changing the type filter automatically refreshes the species dropdown to show only species of that type.</p>
    <p><strong>Downloads</strong> export filtered data as CSV files compatible with Excel, R, Python, and most ecological analysis software. <em>Detections CSV</em> has one row per individual detection; <em>Sessions CSV</em> has one row per species per listening window, with aggregate statistics.</p>
    <p><strong>Clear All Logs</strong> permanently deletes all detection and session data. This cannot be undone — download your data first.</p>`
  },
  heatmap: {
    icon: '🌡', title: 'Activity Heatmaps',
    body: `<p>Heatmaps reveal <strong>patterns in when species are active</strong> across time — something that is impossible to see in a list of individual detections.</p>
    <p><strong>Time of Day heatmap:</strong> Each row is a species; each column is an hour (00:00–23:00). Darker green indicates more detections in that hour. Dawn chorus species like Robin and Blackbird will show a clear early-morning peak. Nocturnal species like owls and bats will show activity after dusk.</p>
    <p><strong>Month of Year heatmap:</strong> Same species rows, but columns represent January through December. As data accumulates across seasons, this reveals whether a species is a summer migrant, a winter visitor, or resident year-round.</p>
    <p>These heatmaps are generated fresh from your detection data each time — the longer BASE runs, the richer the patterns become.</p>`
  },
  sai: {
    icon: '🌱', title: 'Soil Acoustic Index (SAI)',
    body: `<p>The Soil Acoustic Index (SAI) is a <strong>beta measure of biological activity in the soil</strong>, derived from audio captured by a contact microphone or geophone placed on or in the soil.</p>
    <p>After the audio is bandpass-filtered (50–2000 Hz) to remove wind, traffic, and high-frequency noise, three acoustic indices are combined:</p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>RMS energy</strong> — raw signal strength; scales with the intensity of activity.</li>
      <li><strong>Acoustic Complexity Index (ACI)</strong> — measures how varied the sound is across time. Biological signals (worm movement, root growth) produce irregular, complex patterns; mechanical interference (vibration, rain) produces regular, repeating patterns.</li>
      <li><strong>Spectral entropy</strong> — biological broadband activity spreads energy across many frequencies (high entropy); monotone mechanical noise concentrates it (low entropy).</li>
    </ul>
    <p><em>This is a beta feature.</em> The thresholds have not been calibrated against labelled soil recordings from Blenheim — treat SAI values as indicative and useful for relative comparison across time, not as absolute measurements.</p>`
  },
  wai: {
    icon: '💧', title: 'Water Acoustic Index (WAI)',
    body: `<p>The Water Acoustic Index (WAI) is a <strong>beta measure of biological activity in water</strong>, derived from audio captured by a submersible hydrophone. Designed for the Great Lake at Blenheim Palace.</p>
    <p>The WAI uses a multiplicative three-term score — all three must be high for a high WAI, making it robust to individual noise artefacts:</p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>Normalised Difference Water Index (NDWI)</strong> — compares power in the biological band (300–5000 Hz, fish calls and invertebrates) against the anthropogenic band (10–200 Hz, boat motors and flow noise). A high NDWI means the energy is biological, not mechanical.</li>
      <li><strong>Bio-band RMS energy</strong> — the raw signal strength in the biological frequency range. Scales with the intensity of underwater activity.</li>
      <li><strong>Acoustic Complexity Index (ACI)</strong> — fish choruses and invertebrate clicks are temporally varied; steady flow noise and motor drone are monotone. ACI is high for complex, changing signals and low for steady background noise.</li>
    </ul>
    <p>Mains hum (50, 100, 150, 200 Hz) is notched out before analysis to remove electrical interference from hydrophone cables.</p>
    <p><em>This is a beta feature</em> tuned for freshwater lakes. Thresholds and frequency bands should be calibrated against recordings from the specific deployment site and depth.</p>`
  },
  mqtt: {
    icon: '📡', title: 'MQTT Live Feed',
    body: `<p>MQTT (Message Queuing Telemetry Transport) is a lightweight messaging protocol designed for low-bandwidth, real-time data — originally developed for satellite telemetry and now widely used in IoT and ecological monitoring.</p>
    <p>When enabled, BASE publishes every detection as a JSON message to an MQTT broker within milliseconds of the species being identified. Any connected subscriber — a dashboard, alerting system, database, or custom application — receives the data instantly.</p>
    <p><strong>Connection modes:</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li><strong>Direct</strong> — BASE connects straight to a broker (e.g. EMQX Cloud). Good when the machine has internet access.</li>
      <li><strong>Bridge</strong> — BASE connects to a local Mosquitto broker, which forwards to a cloud broker. Good when using a fixed local IP on a private network.</li>
    </ul>
    <p>Use the <strong>Test Connection</strong> button to verify your broker credentials before starting a session.</p>`
  },
  mics: {
    icon: '🎙', title: 'Monitoring Locations',
    body: `<p>Monitoring Locations define each individual microphone deployed across the site — its friendly name, GPS coordinates, and optionally the ALSA device name used to record from it.</p>
    <p><strong>Why configure locations?</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li>The full array is broadcast via MQTT every time the pipeline connects, so the live viewer and any connected map application immediately know where every mic is.</li>
      <li>If you deploy multiple microphones around a large site, each detection can be pinpointed to the right mic — essential for understanding spatial patterns in species activity.</li>
      <li>The optional ALSA device name links a location to a specific USB audio device so the right classifier is routed to the right microphone.</li>
    </ul>
    <p>Changes take effect on the next pipeline start.</p>`
  },
  location: {
    icon: '📍', title: 'Site Name',
    body: `<p>The site name, latitude, and longitude identify the overall recording site — published as <code>site_name</code> in every detection record, CSV export, and MQTT payload.</p>
    <p><strong>Site Name vs Monitoring Locations:</strong> Site Name is the top-level label for the whole deployment (e.g. "Blenheim Estate"). Monitoring Locations are the individual microphone positions within that site (e.g. "South Control", "North Meadow") — configured separately below.</p>
    <p><strong>Why it matters:</strong></p>
    <ul style="padding-left:16px;margin:8px 0">
      <li>BirdNET uses the coordinates to apply a <strong>regional species filter</strong>, improving accuracy for your location and season.</li>
      <li>Location data makes exported CSVs <strong>directly importable into ecological databases</strong> (NBN Atlas, iRecord, GBIF) without manual annotation.</li>
    </ul>`
  }
};

function showHelp(topic) {
  const h = HELP[topic];
  if (!h) return;
  document.getElementById('help-icon').textContent = h.icon;
  document.getElementById('help-title').textContent = h.title;
  document.getElementById('help-body').innerHTML = h.body;
  document.getElementById('help-overlay').classList.add('show');
}
function hideHelp() {
  document.getElementById('help-overlay').classList.remove('show');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideHelp(); hideAbout(); } });
window.showHelp = showHelp;
window.hideHelp = hideHelp;

function helpBtn(topic) {
  return `<span class="help-icon" onclick="showHelp('${topic}')" title="Help">?</span>`;
}

/* ── About modal ── */
function showAbout() {
  const v = document.getElementById('about-version');
  const hv = document.getElementById('version');
  if (v && hv) v.textContent = hv.textContent;
  document.getElementById('about-overlay').classList.add('show');
}
function hideAbout() {
  document.getElementById('about-overlay').classList.remove('show');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideAbout(); });
window.showAbout = showAbout;
window.hideAbout = hideAbout;

/* ── Live Spectrogram ── */
const _spec = {
  running: false,
  animFrame: null,
  audioCtx: null,
  analyser: null,
  stream: null,
  source: null,
  monitorGain: null,
  monitoring: false,
  freqData: null,
  evtSource: null,       // EventSource when using server-side FFT streaming
  serverData: null,      // latest FFT Uint8Array received from server
  serverMode: false,     // true when server captures audio (location selected)
  monitorCtx: null,      // AudioContext for server-mode headphone monitoring
  monitorNode: null,     // AudioWorkletNode feeding the speaker
  monitorGainNode: null, // GainNode between worklet and destination
  monitorAbort: null,    // AbortController for the fetch PCM stream
  monitorReader: null,   // ReadableStreamDefaultReader for the PCM stream
  preset: null,          // active classifier preset {fMin, fMax, label, color, rate, decimation}
  sampleRate: 48000,     // actual capture rate of the current stream
};

// Per-classifier spectrogram display presets.
// fMin/fMax: frequency range to display (Hz).  rate: parec capture rate.
// decimation: for audio monitor — take every Nth sample to shift freqs into audible range.
const _SPEC_PRESETS = {
  bird:   { fMin: 300,   fMax: 12000,  minDb: -90, maxDb: -30, rate: 48000,  decimation: 1, label: 'Bird 0.3–12 kHz',       color: '#90b20c' },
  bee:    { fMin: 80,    fMax: 4000,   minDb: -90, maxDb: -20, rate: 48000,  decimation: 1, label: 'Bee 0.08–4 kHz',         color: '#f5c842' },
  insect: { fMin: 3000,  fMax: 20000,  minDb: -85, maxDb: -25, rate: 48000,  decimation: 1, label: 'Orthoptera 3–20 kHz',    color: '#ff8c42' },
  soil:   { fMin: 30,    fMax: 2000,   minDb: -95, maxDb: -20, rate: 48000,  decimation: 1, label: 'Soil 0.03–2 kHz',        color: '#c2956a' },
  water:  { fMin: 10,    fMax: 8000,   minDb: -95, maxDb: -25, rate: 48000,  decimation: 1, label: 'Water 0.01–8 kHz',       color: '#42b4f5' },
  bat:    { fMin: 15000, fMax: 120000, minDb: -90, maxDb: -30, rate: 384000, decimation: 8, label: 'Bat 15–120 kHz',         color: '#c084fc' },
};

// Resolve a preset from an array of classifier names (e.g. ['bird','bee']).
// If multiple classifiers are active, merges their frequency ranges so all are visible.
function _resolveSpecPreset(classifiers) {
  if (!classifiers || !classifiers.length) return null;
  const active = classifiers.map(c => _SPEC_PRESETS[c]).filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return { ...active[0] };
  return {
    fMin: Math.min(...active.map(p => p.fMin)),
    fMax: Math.max(...active.map(p => p.fMax)),
    minDb: Math.min(...active.map(p => p.minDb)),
    maxDb: Math.max(...active.map(p => p.maxDb)),
    rate: Math.max(...active.map(p => p.rate)),
    decimation: Math.max(...active.map(p => p.decimation)),
    label: active.map(p => p.label).join(' + '),
    color: active[0].color,
  };
}

// Viridis-inspired colormap scaled to BASE's green theme
function _specColor(v) {
  // v: 0–255
  if (v < 12)  return [13, 26, 16];          // background (silent)
  if (v < 50)  return [15, 45, 80];          // dark blue
  if (v < 100) return [20, 100, 120];         // teal
  if (v < 150) return [40, 160, 100];         // green
  if (v < 200) return [130, 210, 60];         // yellow-green
  if (v < 230) return [230, 180, 30];         // amber
  return            [255, 80,  30];           // hot red-orange
}

function _fmtHz(f) {
  if (f >= 1000) return (f / 1000).toFixed(f % 1000 ? 1 : 0) + 'k';
  return String(Math.round(f));
}

function _buildFreqAxis(sampleRate, logScale, preset) {
  const el = document.getElementById('spec-axis');
  if (!el) return;
  const nyquist = sampleRate / 2;
  const fMin = preset?.fMin ?? 0;
  const fMax = preset?.fMax ?? nyquist;
  let labels;
  if (logScale) {
    // Log-spaced labels within the preset range
    const logMin = Math.log10(Math.max(fMin, 1));
    const logMax = Math.log10(Math.max(fMax, 1));
    labels = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(Math.pow(10, logMax - t * (logMax - logMin))));
  } else {
    labels = [fMax, fMin + (fMax-fMin)*0.75, fMin + (fMax-fMin)*0.5, fMin + (fMax-fMin)*0.25, fMin].map(Math.round);
  }
  el.innerHTML = labels.map(f => `<span>${_fmtHz(f)}</span>`).join('');

  // Coloured preset badge next to the axis
  const badge = document.getElementById('spec-preset-badge');
  if (badge) {
    if (preset) {
      badge.textContent = preset.label;
      badge.style.color = preset.color;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

// Populate both the Location dropdown (monitoring locations) and the Mic dropdown
// (all available browser audio inputs by their real labels).
// The Location picker is informational — selecting one suggests a Mic but the user
// can always override by changing the Mic dropdown directly.
// Cached Devices API response so onSpecLocationChange doesn't re-fetch on every change.
let _specApiDevices = [];

async function _populateSpecDevices() {
  try {
    // Unlock real device labels (browser security requirement)
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());

    const locSel = document.getElementById('spec-location');
    const devSel = document.getElementById('spec-device');
    if (!locSel || !devSel) return;

    const prevLocVal = locSel.value || '';
    const prevDevId  = devSel.value || '';

    const [mics, apiResp, browserDevices] = await Promise.all([
      api.get('/api/settings/mics').catch(() => []),
      api.get('/api/devices').catch(() => ({ devices: [] })),
      navigator.mediaDevices.enumerateDevices()
        .then(ds => ds.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')),
    ]);
    _specApiDevices = apiResp.devices || [];

    // Location dropdown — monitoring locations that have a device assigned
    locSel.innerHTML = '<option value="">— any —</option>';
    for (const mic of (mics || [])) {
      if (!mic.device) continue;
      const opt = document.createElement('option');
      opt.value               = mic.device;  // PipeWire source name
      opt.dataset.micName     = mic.name;
      opt.dataset.classifiers = JSON.stringify(mic.classifiers || []);
      opt.textContent         = mic.name;
      locSel.appendChild(opt);
    }

    // Restore location selection, then populate Mic dropdown filtered to that location
    if (prevLocVal) locSel.value = prevLocVal;
    _fillMicDropdown(locSel.value, _specApiDevices, browserDevices, devSel, prevDevId);
  } catch (e) {
    console.warn('Spectrogram device list:', e);
  }
}

// Fill the Mic dropdown to show only the device linked to the selected location,
// using the same label format as the Recording Locations settings page.
// - One clear browser match  → auto-selected, friendly label shown
// - Multiple tied matches    → all shown with (1)/(2) suffix so user can pick
// - No browser match         → shows friendly label with value='' (system default);
//                              "Using:" indicator will reveal what's actually captured
// - No location selected     → all browser devices listed by their actual labels
function _fillMicDropdown(pipewireSource, apiDevices, browserDevices, devSel, preferDeviceId) {
  devSel.innerHTML = '<option value="">System default</option>';

  const anyMicEl  = document.getElementById('spec-any-mic');
  const micBadge  = document.getElementById('spec-mic-badge');

  if (!pipewireSource) {
    // No location — show the mic picker with all browser devices
    if (anyMicEl)  anyMicEl.style.display  = 'flex';
    if (micBadge)  micBadge.style.display   = 'none';
    for (const d of browserDevices) {
      const opt = document.createElement('option');
      opt.value       = d.deviceId;
      opt.textContent = d.label || d.deviceId;
      devSel.appendChild(opt);
    }
    if (preferDeviceId) devSel.value = preferDeviceId;
    return;
  }

  // Location selected — mic is determined automatically; hide the full picker,
  // show a compact badge with the configured mic name instead.
  const locSel    = document.getElementById('spec-location');
  const micName   = locSel?.selectedOptions[0]?.dataset.micName || '';
  const apiEntry  = (apiDevices || []).find(d => d.name === pipewireSource);
  // Prefer the configured mic name; fall back to API label, then a shortened PipeWire name
  const displayName = micName || apiEntry?.label
    || pipewireSource.split('.').filter(p => p && !/^\d+$/.test(p)).slice(-2).join(' ');

  if (anyMicEl) anyMicEl.style.display = 'none';
  if (micBadge) { micBadge.textContent = displayName; micBadge.style.display = 'inline-flex'; }

  // Still populate devSel so server-mode / fallback paths have a value
  const candidates = _candidatesForSource(pipewireSource, browserDevices);
  if (candidates.length === 0) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = displayName;
    devSel.appendChild(opt);
  } else if (candidates.length === 1) {
    const opt = document.createElement('option'); opt.value = candidates[0].deviceId; opt.textContent = displayName;
    devSel.appendChild(opt); devSel.value = candidates[0].deviceId;
  } else {
    candidates.forEach((d, i) => {
      const opt = document.createElement('option'); opt.value = d.deviceId;
      opt.textContent = `${displayName} (${i + 1})`; devSel.appendChild(opt);
    });
    if (preferDeviceId) devSel.value = preferDeviceId;
  }
}

// Return all browser devices that score highest against a PipeWire source name.
// Returns multiple entries when devices are identical-model (same label, equal score)
// so the user can choose; returns [] when no device scores above zero.
function _candidatesForSource(pipewireSource, browserDevices) {
  const src = pipewireSource.toLowerCase();
  const GENERIC = new Set([
    'alsa', 'input', 'output', 'fallback', 'info',
    'usb', 'stereo', 'mono', 'analog', 'digital', 'audio', 'device',
  ]);
  const keywords = src
    .replace(/[_\-.]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length >= 3 &&
      !/^\d+$/.test(w) &&
      !/^[0-9a-f]{4,}$/.test(w) &&
      !GENERIC.has(w)
    );

  const isPci = src.includes('.pci-');
  const isUsb = src.includes('.usb-');

  let maxScore = 0;
  const scored = browserDevices.map(d => {
    const label = (d.label || '').toLowerCase();
    let score = keywords.filter(w => label.includes(w)).length;
    if (isPci && (label.includes('built') || label.includes('internal'))) score += 0.5;
    if (isUsb && keywords.length > 0 && label.includes('usb')) score += 0.5;
    if (score > maxScore) maxScore = score;
    return { d, score };
  });

  if (maxScore === 0) return [];
  return scored.filter(({ score }) => score === maxScore).map(({ d }) => d);
}

// When the user picks a monitoring location, repopulate the Mic dropdown
// to show only that location's linked devices, then restart if running.
async function onSpecLocationChange() {
  const locSel = document.getElementById('spec-location');
  const devSel = document.getElementById('spec-device');
  if (!locSel || !devSel) return;

  const browserDevices = await navigator.mediaDevices.enumerateDevices()
    .then(ds => ds.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'));

  _fillMicDropdown(locSel.value, _specApiDevices, browserDevices, devSel, '');

  if (_spec.running) {
    const wasMonitoring = _spec.monitoring;
    _stopSpectrogram();
    await _startSpectrogram();
    if (wasMonitoring && !_spec.serverMode) toggleMonitor();
  }
}

// Sync the Location dropdown to whichever pipeline is running (no device change).
function _syncSpecToRunningDevice() {
  const locSel = document.getElementById('spec-location');
  if (!locSel || !state.status) return;
  const running = Object.values(state.status.pipelines || {})
    .filter(p => p.state !== 'idle' && p.device_name);
  if (running.length !== 1) return;

  const targetName = running[0].device_name;
  for (const opt of locSel.options) {
    if (opt.dataset.micName === targetName) { locSel.value = opt.value; return; }
  }
}

async function changeSpecDevice() {
  if (!_spec.running || _spec.serverMode) return;
  const wasMonitoring = _spec.monitoring;
  _stopSpectrogram();
  await _startSpectrogram();
  if (wasMonitoring) toggleMonitor();
}

async function toggleSpectrogram() {
  const panel = document.getElementById('spec-panel');
  const btn   = document.getElementById('btn-spec-toggle');
  if (_spec.running) {
    _stopSpectrogram();
    panel.classList.remove('show');
    btn.textContent = '▶ Start';
    return;
  }
  panel.classList.add('show');
  btn.textContent = '⟳ Starting…';
  await _populateSpecDevices();
  await _startSpectrogram();
  btn.textContent = '■ Stop';
}

async function _startSpectrogram() {
  const pipewireSource = document.getElementById('spec-location')?.value || '';
  if (pipewireSource) {
    _startServerSpectrogram(pipewireSource);
  } else {
    await _startBrowserSpectrogram();
  }
}

// Server captures audio from the named PipeWire source and streams FFT data via SSE.
// This bypasses browser deviceId matching entirely — works even when two USB mics
// share the same generic browser label.
function _startServerSpectrogram(pipewireSource) {
  const canvas = document.getElementById('spec-canvas');
  if (!canvas) return;
  canvas.width = canvas.offsetWidth || 1200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1a10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const locSel = document.getElementById('spec-location');
  const selectedOpt = locSel?.selectedOptions[0];
  const classifiers = JSON.parse(selectedOpt?.dataset.classifiers || '[]');
  const preset = _resolveSpecPreset(classifiers);
  _spec.preset = preset;
  _spec.sampleRate = preset?.rate || 48000;

  _buildFreqAxis(_spec.sampleRate, document.getElementById('spec-log')?.checked || false, preset);

  // locationName is already visible in the Location dropdown — no extra indicator needed

  _spec.serverMode = true;
  _spec.running = true;
  _spec.serverData = null;

  const url = `/api/spectrogram/stream?device=${encodeURIComponent(pipewireSource)}&rate=${_spec.sampleRate}`;
  _spec.evtSource = new EventSource(url);

  _spec.evtSource.onmessage = (e) => {
    if (!_spec.running) return;
    try {
      const msg = JSON.parse(e.data);
      // msg is either {bins:[...], rate:N} (new format) or a bare array (legacy)
      _spec.serverData = msg.bins || msg;
      if (msg.rate && msg.rate !== _spec.sampleRate) {
        _spec.sampleRate = msg.rate;
      }
    } catch { return; }
    // rAF loop is already running — just update the data buffer
  };

  _spec.evtSource.onerror = () => {
    if (_spec.running) {
      toast('Spectrogram stream error — is parec installed?', 'error', 5000);
      _stopSpectrogram();
      const btn = document.getElementById('btn-spec-toggle');
      if (btn) btn.textContent = '▶ Start';
    }
  };

  // Start the continuous 60fps draw loop — reuses last SSE data between messages
  _spec.animFrame = requestAnimationFrame(_specDraw);
}

// Browser captures audio via getUserMedia (used when no location is selected).
// Headphone monitoring is only available in this mode.
async function _startBrowserSpectrogram() {
  const deviceId = document.getElementById('spec-device')?.value || null;
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
  try {
    _spec.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const trackLabel = _spec.stream.getAudioTracks()[0]?.label || '';
    const micBadge2 = document.getElementById('spec-mic-badge');
    if (micBadge2 && trackLabel) { micBadge2.textContent = trackLabel; micBadge2.style.display = 'inline-flex'; }

    // Browser mics are always 48kHz; apply preset for display range only
    const locSel2 = document.getElementById('spec-location');
    const selectedOpt2 = locSel2?.selectedOptions[0];
    const cls2 = JSON.parse(selectedOpt2?.dataset.classifiers || '[]');
    const preset2 = _resolveSpecPreset(cls2);
    _spec.preset = preset2;
    _spec.sampleRate = 48000;

    _spec.audioCtx = new AudioContext({ sampleRate: 48000 });
    _spec.analyser = _spec.audioCtx.createAnalyser();
    _spec.analyser.fftSize = 4096;
    _spec.analyser.smoothingTimeConstant = 0.1;
    if (preset2) {
      _spec.analyser.minDecibels = preset2.minDb;
      _spec.analyser.maxDecibels = preset2.maxDb;
    }
    _spec.source = _spec.audioCtx.createMediaStreamSource(_spec.stream);
    _spec.source.connect(_spec.analyser);
    _spec.freqData = new Uint8Array(_spec.analyser.frequencyBinCount);
    _spec.monitorGain = null;
    _spec.monitoring = false;
    _spec.serverMode = false;

    const canvas = document.getElementById('spec-canvas');
    canvas.width = canvas.offsetWidth || 1200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1a10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    _buildFreqAxis(48000, document.getElementById('spec-log')?.checked || false, preset2);

    _spec.running = true;
    _specDraw();
  } catch (err) {
    toast(`Spectrogram: ${err.message}`, 'error', 5000);
    document.getElementById('btn-spec-toggle').textContent = '▶ Start';
  }
}

function _stopAudioMonitor() {
  if (_spec.monitorReader) { _spec.monitorReader.cancel(); _spec.monitorReader = null; }
  if (_spec.monitorAbort) { _spec.monitorAbort.abort(); _spec.monitorAbort = null; }
  if (_spec.monitorGainNode) { _spec.monitorGainNode.disconnect(); _spec.monitorGainNode = null; }
  if (_spec.monitorNode) { _spec.monitorNode.disconnect(); _spec.monitorNode = null; }
  if (_spec.monitorCtx) { _spec.monitorCtx.close(); _spec.monitorCtx = null; }
  _spec.monitoring = false;
  const btn = document.getElementById('btn-spec-monitor');
  if (btn) { btn.classList.remove('active'); btn.title = 'Listen in'; }
}

async function _startAudioMonitor(pipewireSource) {
  if (_spec.monitoring) { _stopAudioMonitor(); return; }
  const btn = document.getElementById('btn-spec-monitor');
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('/audio-monitor-worklet.js');
    const workletNode = new AudioWorkletNode(ctx, 'audio-monitor-processor');
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1.0;
    workletNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    _spec.monitorCtx = ctx;
    _spec.monitorNode = workletNode;
    _spec.monitorGainNode = gainNode;
    _spec.monitorAbort = new AbortController();
    _spec.monitoring = true;
    if (btn) { btn.classList.add('active'); btn.title = 'Stop listening'; }

    const captureRate = _spec.preset?.rate || 48000;
    const decimation  = _spec.preset?.decimation || 1;
    const url = `/api/spectrogram/audio?device=${encodeURIComponent(pipewireSource)}&rate=${captureRate}`;
    const resp = await fetch(url, { signal: _spec.monitorAbort.signal });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

    const reader = resp.body.getReader();
    _spec.monitorReader = reader;

    // Read PCM chunks, convert Int16 → Float32.
    // For bat (decimation=8): keep every 8th sample — shifts 40kHz bat call → 5kHz audible.
    while (true) {
      const { done, value } = await reader.read();
      if (done || !_spec.monitoring) break;
      const i16 = new Int16Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 2));
      const outLen = Math.ceil(i16.length / decimation);
      const f32 = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) f32[i] = i16[i * decimation] / 32768.0;
      workletNode.port.postMessage(f32);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      toast(`Monitor: ${err.message}`, 'error', 5000);
    }
    _stopAudioMonitor();
  }
}

function _stopSpectrogram() {
  _stopAudioMonitor();
  _spec.running = false;
  _spec.serverMode = false;
  _spec.serverData = null;
  _spec.preset = null;
  _spec.sampleRate = 48000;
  if (_spec.evtSource) { _spec.evtSource.close(); _spec.evtSource = null; }
  if (_spec.animFrame) { cancelAnimationFrame(_spec.animFrame); _spec.animFrame = null; }
  if (_spec.monitorGain) { _spec.monitorGain.disconnect(); _spec.monitorGain = null; }
  if (_spec.stream) _spec.stream.getTracks().forEach(t => t.stop());
  if (_spec.audioCtx) _spec.audioCtx.close();
  _spec.analyser = _spec.audioCtx = _spec.stream = _spec.source = _spec.freqData = null;
  const monBtn = document.getElementById('btn-spec-monitor');
  if (monBtn) { monBtn.classList.remove('active'); monBtn.title = 'Listen in'; }
  const micBadge = document.getElementById('spec-mic-badge');
  if (micBadge) micBadge.style.display = 'none';
  const badge = document.getElementById('spec-preset-badge');
  if (badge) badge.style.display = 'none';
}

function toggleMonitor() {
  if (_spec.serverMode) {
    const pipewireSource = document.getElementById('spec-location')?.value || '';
    _startAudioMonitor(pipewireSource);
    return;
  }
  if (!_spec.running || !_spec.source) {
    toast('Start the spectrogram first', 'warn');
    return;
  }
  if (_spec.monitoring) {
    if (_spec.monitorGain) { _spec.monitorGain.disconnect(); _spec.monitorGain = null; }
    _spec.monitoring = false;
    const btn = document.getElementById('btn-spec-monitor');
    if (btn) { btn.classList.remove('active'); btn.title = 'Listen in'; }
  } else {
    _spec.monitorGain = _spec.audioCtx.createGain();
    _spec.monitorGain.gain.value = 1.0;
    _spec.source.connect(_spec.monitorGain);
    _spec.monitorGain.connect(_spec.audioCtx.destination);
    _spec.monitoring = true;
    const btn = document.getElementById('btn-spec-monitor');
    if (btn) { btn.classList.add('active'); btn.title = 'Stop listening'; }
  }
}

function _specDraw() {
  if (!_spec.running) return;
  const canvas = document.getElementById('spec-canvas');
  if (!canvas) { _spec.running = false; return; }
  const ctx = canvas.getContext('2d');
  const logScale = document.getElementById('spec-log')?.checked || false;

  let data;
  if (_spec.serverMode) {
    // Reuse last SSE data — new data arrives at ~23fps but rAF loop runs at 60fps.
    // This keeps scrolling smooth; each FFT frame naturally spans ~3 draw columns.
    data = _spec.serverData;
    if (!data) {
      _spec.animFrame = requestAnimationFrame(_specDraw);
      return;  // waiting for first SSE message
    }
  } else {
    const analyser = _spec.analyser;
    if (!analyser) return;
    data = _spec.freqData || new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
  }

  const bins = data.length;
  const w = canvas.width;
  const h = canvas.height;

  // Map preset fMin/fMax to bin indices so only the relevant frequency range fills the canvas
  const nyquist = (_spec.sampleRate || 48000) / 2;
  const preset  = _spec.preset;
  const fMinBin = preset ? Math.max(0, Math.floor(preset.fMin / nyquist * bins)) : 0;
  const fMaxBin = preset ? Math.min(bins - 1, Math.ceil(preset.fMax / nyquist * bins)) : bins - 1;

  // Scroll left by 2px for readable speed
  const scroll = 2;
  const img = ctx.getImageData(scroll, 0, w - scroll, h);
  ctx.putImageData(img, 0, 0);

  // Draw new columns on the right
  const col = ctx.createImageData(scroll, h);
  const px  = col.data;

  for (let y = 0; y < h; y++) {
    const t = 1 - y / h;   // 0 = bottom (fMin), 1 = top (fMax)
    let binIndex;
    if (logScale) {
      const logLow  = Math.log(Math.max(fMinBin, 1));
      const logHigh = Math.log(Math.max(fMaxBin, 1));
      binIndex = Math.round(Math.exp(logLow + t * (logHigh - logLow)));
    } else {
      binIndex = Math.floor(fMinBin + t * (fMaxBin - fMinBin));
    }
    binIndex = Math.min(Math.max(binIndex, 0), bins - 1);
    const value = data[binIndex];
    const [r, g, b] = _specColor(value);
    for (let xi = 0; xi < scroll; xi++) {
      const i = (y * scroll + xi) * 4;
      px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = 255;
    }
  }
  ctx.putImageData(col, w - scroll, 0);

  _spec.animFrame = requestAnimationFrame(_specDraw);
}

window.toggleSpectrogram = toggleSpectrogram;

/* ── Test File — data declared here so they're initialised before router.init() ── */
let _tfFile = null;
const _CLASSIFIERS = [
  { id: 'bird',   label: '🐦 Bird',   note: 'BirdNET · 48 kHz' },
  { id: 'bat',    label: '🦇 Bat',    note: 'BatDetect2 · 384 kHz' },
  { id: 'bee',    label: '🐝 Bee',    note: 'BuzzDetect · 16 kHz' },
  { id: 'insect', label: '🦗 Insect', note: 'Orthoptera CNN · 44.1 kHz' },
  { id: 'soil',   label: '🌱 Soil',   note: 'SAI v2 · 22 kHz' },
  { id: 'water',  label: '💧 Water',  note: 'WAI · 44.1 kHz' },
];

/* ── Boot ── */
router.init();
ws.connect();
pollStatus();
setInterval(pollStatus, POLL_INTERVAL);

window.deleteWindow = deleteWindow;
window.loadClips = loadClips;
window.filterClips = filterClips;
window.deleteClip = deleteClip;
window.startDevice = startDevice;
window.stopDevice = stopDevice;
window.setFilter = setFilter;
window.changeSpecDevice   = changeSpecDevice;
window.onSpecLocationChange = onSpecLocationChange;
window.showMicEditForm = showMicEditForm;
window.hideMicEditForm = hideMicEditForm;
window.saveMicEdit = saveMicEdit;
window.deleteMicRow = deleteMicRow;
window.showMicAddForm = showMicAddForm;
window.hideMicAddForm = hideMicAddForm;
window.confirmAddMic = confirmAddMic;
window.toggleBoot = toggleBoot;

// ── Boot-on-startup toggle ────────────────────────────────────────────────

async function _refreshBootStatus() {
  try {
    const s = await api.get('/api/system/boot');
    const toggle  = document.getElementById('boot-toggle');
    const chip    = document.getElementById('boot-status-chip');
    const detail  = document.getElementById('boot-detail');
    if (!toggle) return;

    const on = s.boot_enabled;
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    toggle.classList.toggle('boot-toggle--on', on);

    if (on) {
      chip.textContent = 'Enabled';
      chip.style.background = 'var(--success-bg, #d4edda)';
      chip.style.color = 'var(--success, #2d7a3a)';
      detail.textContent = 'Recording will resume automatically after reboot or power cut.';
    } else {
      chip.textContent = 'Disabled';
      chip.style.background = 'var(--surface2)';
      chip.style.color = 'var(--muted)';
      detail.textContent = s.service_installed
        ? 'Service installed but not enabled — recording will not start on boot.'
        : 'Service not installed on this device. Enable below to set up boot-start.';
    }
  } catch { /* non-fatal — may not be available on non-Linux */ }
}

async function toggleBoot() {
  const toggle = document.getElementById('boot-toggle');
  if (!toggle) return;
  const currentlyOn = toggle.getAttribute('aria-checked') === 'true';
  const enable = !currentlyOn;

  toggle.style.opacity = '0.5';
  toggle.style.pointerEvents = 'none';
  try {
    const r = await api.post('/api/system/boot', { enabled: enable });
    if (!r.ok && r.errors?.length) {
      toast('Boot setup error: ' + r.errors.join('; '), 'error', 6000);
    } else {
      toast(enable ? 'Boot-start enabled — will auto-resume after reboot' : 'Boot-start disabled', enable ? 'success' : 'warn', 4000);
    }
    await _refreshBootStatus();
  } catch (err) {
    toast(err.message, 'error', 5000);
  } finally {
    toggle.style.opacity = '';
    toggle.style.pointerEvents = '';
  }
}

/* ── Test File page ─────────────────────────────────────────────────────────── */

function renderTestFile() {
  document.getElementById('main').innerHTML = `
<div class="page-header">
  <h2>Test Audio File</h2>
  <p class="page-subtitle">Upload a WAV recording and run it through any classifier to see what BASE detects.</p>
</div>

<div class="card" style="max-width:680px">

  <div id="tf-dropzone" class="tf-dropzone" onclick="document.getElementById('tf-file').click()">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:8px;opacity:.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
    <div id="tf-drop-label">Drop a WAV file here or click to browse</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:4px">WAV format · mono or stereo · any sample rate</div>
  </div>
  <input type="file" id="tf-file" accept=".wav,audio/wav,audio/wave" style="display:none">

  <div style="margin-top:20px">
    <div style="font-size:.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Classifiers</div>
    <div class="tf-clf-grid">
      ${_CLASSIFIERS.map(c => `
      <label class="tf-clf-card" id="tf-card-${c.id}">
        <input type="checkbox" class="tf-clf-check" value="${c.id}" checked>
        <span class="tf-clf-label">${c.label}</span>
        <span class="tf-clf-note">${c.note}</span>
      </label>`).join('')}
    </div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:8px">
      🦇 Bat classifier requires a 384 kHz AudioMoth recording — standard microphone files will show no detections.
    </div>
  </div>

  <div style="margin-top:20px">
    <div style="font-size:.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">🦇 Bat thresholds <span style="font-weight:400;text-transform:none;letter-spacing:0">(override for this test only)</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label style="font-size:.85rem">
        Detection confidence
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <input type="range" id="tf-det-conf" min="0.05" max="0.95" step="0.05" value="0.4"
            oninput="document.getElementById('tf-det-val').textContent=parseFloat(this.value).toFixed(2)"
            style="flex:1">
          <span id="tf-det-val" style="font-size:.85rem;font-weight:600;min-width:34px">0.40</span>
        </div>
      </label>
      <label style="font-size:.85rem">
        Class confidence
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <input type="range" id="tf-class-conf" min="0.05" max="0.95" step="0.05" value="0.4"
            oninput="document.getElementById('tf-class-val').textContent=parseFloat(this.value).toFixed(2)"
            style="flex:1">
          <span id="tf-class-val" style="font-size:.85rem;font-weight:600;min-width:34px">0.40</span>
        </div>
      </label>
    </div>
  </div>

  <div style="margin-top:20px;display:flex;gap:10px;align-items:center">
    <button class="btn btn-primary" id="tf-run" disabled onclick="runTestFile()">Run classifiers</button>
    <span id="tf-status" style="font-size:.85rem;color:var(--muted)"></span>
  </div>
</div>

<div id="tf-results" style="max-width:680px;margin-top:16px"></div>

<style>
.tf-dropzone {
  border: 2px dashed var(--border);
  border-radius: 10px;
  padding: 32px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s, background .2s;
  color: var(--text);
  font-size: .9rem;
}
.tf-dropzone:hover, .tf-dropzone.drag-over {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 6%, transparent);
}
.tf-dropzone.has-file { border-style: solid; border-color: var(--primary); }
.tf-clf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
  gap: 8px;
}
.tf-clf-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color .15s, background .15s;
  user-select: none;
}
.tf-clf-card:has(.tf-clf-check:checked) {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.tf-clf-card input { display: none; }
.tf-clf-label { font-size: .9rem; font-weight: 600; }
.tf-clf-note  { font-size: .72rem; color: var(--muted); }
.tf-result-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.tf-result-row:last-child { border-bottom: none; }
.tf-conf-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--primary);
  opacity: .7;
}
.tf-no-results { text-align:center; padding: 32px; color: var(--muted); font-size: .9rem; }
</style>`;

  // ── File drop/select wiring ───────────────────────────────────────────────
  const input    = document.getElementById('tf-file');
  const dropzone = document.getElementById('tf-dropzone');
  const runBtn   = document.getElementById('tf-run');
  const label    = document.getElementById('tf-drop-label');

  function setFile(file) {
    if (!file) return;
    _tfFile = file;   // store in module-level var so runTestFile can reach it
    label.textContent = `📄 ${file.name}  (${(file.size / 1024).toFixed(0)} KB)`;
    dropzone.classList.add('has-file');
    runBtn.disabled = false;
  }

  _tfFile = null;  // reset on each page render
  input.addEventListener('change', () => setFile(input.files[0]));

  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);  // input.files is read-only; use _tfFile instead
  });
}

async function runTestFile() {
  const runBtn   = document.getElementById('tf-run');
  const status   = document.getElementById('tf-status');
  const results  = document.getElementById('tf-results');

  if (!_tfFile) { toast('Please select a WAV file first', 'warn'); return; }

  const selected = [...document.querySelectorAll('.tf-clf-check:checked')].map(el => el.value);
  if (!selected.length) { toast('Select at least one classifier', 'warn'); return; }

  runBtn.disabled   = true;
  status.textContent = 'Running… this may take 10–30 seconds';
  results.innerHTML  = '';

  try {
    const detConf   = document.getElementById('tf-det-conf')?.value   ?? '0.4';
    const classConf = document.getElementById('tf-class-conf')?.value ?? '0.4';
    const qs  = [
      ...selected.map(c => `classifiers=${encodeURIComponent(c)}`),
      `det_conf=${detConf}`,
      `class_conf=${classConf}`,
    ].join('&');
    const fd  = new FormData();
    fd.append('file', _tfFile);

    const res = await fetch(`/api/test/classify?${qs}`, { method: 'POST', body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = Array.isArray(body.detail)
        ? body.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
        : body.detail || `Server error (${res.status})`;
      throw new Error(detail);
    }

    const dets = await res.json();
    status.textContent = `${dets.filter(d => d.label).length} detection(s) found`;
    _renderTestResults(results, dets, selected);

  } catch (err) {
    status.textContent = '';
    toast(err.message, 'error', 6000);
  } finally {
    runBtn.disabled = false;
  }
}

function _renderTestResults(container, dets, classifiers) {
  const byClassifier = {};
  for (const c of classifiers) byClassifier[c] = [];
  for (const d of dets) {
    if (d.label) (byClassifier[d.classifier] ||= []).push(d);
  }

  const sections = classifiers.map(id => {
    const cfg   = _CLASSIFIERS.find(c => c.id === id);
    const items = byClassifier[id] || [];

    const rows = items.length
      ? items.sort((a, b) => b.confidence - a.confidence).map(d => `
        <div class="tf-result-row">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.9rem">${d.label}</div>
            ${d.metadata?.scientific_name ? `<div style="font-size:.75rem;color:var(--muted);font-style:italic">${d.metadata.scientific_name}</div>` : ''}
            ${_metaSnippet(d.metadata)}
          </div>
          <div style="text-align:right;min-width:70px">
            <div style="font-size:.85rem;font-weight:600">${(d.confidence * 100).toFixed(1)}%</div>
            <div class="tf-conf-bar" style="width:${Math.round(d.confidence * 100)}%"></div>
          </div>
        </div>`).join('')
      : `<div class="tf-no-results">No detections — try a different recording or lower the confidence threshold in settings</div>`;

    return `
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:12px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <strong style="font-size:.9rem">${cfg?.label || id}</strong>
        <span style="font-size:.75rem;color:var(--muted)">${cfg?.note || ''}</span>
        ${items.length ? `<span style="margin-left:auto;font-size:.75rem;font-weight:600;color:var(--primary)">${items.length} detection${items.length !== 1 ? 's' : ''}</span>` : ''}
      </div>
      ${rows}
    </div>`;
  });

  container.innerHTML = sections.join('');
}

function _metaSnippet(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.low_freq_hz)   parts.push(`${(meta.low_freq_hz / 1000).toFixed(1)} kHz`);
  if (meta.det_prob)      parts.push(`det ${(meta.det_prob * 100).toFixed(0)}%`);
  if (meta.group)         parts.push(meta.group);
  if (meta.activity_level) parts.push(meta.activity_level);
  if (meta.error)         parts.push(`⚠ ${meta.error}`);
  return parts.length ? `<div style="font-size:.72rem;color:var(--muted);margin-top:2px">${parts.join(' · ')}</div>` : '';
}
