/* ════════════════════════════════════════════════════════════════
   Job Tracker
   - Local-first: everything works with no backend (localStorage).
   - Optional Google Sheets sync via an Apps Script Web App (gas/Code.gs).
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* ─────────────────────────── constants ─────────────────────── */

/* config.js is optional; every read goes through here so a missing file
   or a missing key just falls back to the built-in default. */
const CONFIG = window.JT_CONFIG || {};
const conf = (key, fallback) =>
  (CONFIG[key] === undefined || CONFIG[key] === '' ? fallback : CONFIG[key]);

const STATUSES = ['Applied', 'In Progress', 'Rejected', 'Accepted', 'No Reply'];

const STATUS_META = {
  'Applied':     { cls: 's-applied',     cssVar: '--st-applied'  },
  'In Progress': { cls: 's-in-progress', cssVar: '--st-progress' },
  'Rejected':    { cls: 's-rejected',    cssVar: '--st-rejected' },
  'Accepted':    { cls: 's-accepted',    cssVar: '--st-accepted' },
  'No Reply':    { cls: 's-no-reply',    cssVar: '--st-noreply'  },
};

/** Display order for the status chart — see renderDashboard(). */
const CHART_STATUS_ORDER = ['Applied', 'No Reply', 'In Progress', 'Rejected', 'Accepted'];

const JOB_TYPES = ['Remote', 'Hybrid', 'On site'];
const PLATFORMS = ['LinkedIn', 'Company site'];

/** Statuses that go stale — terminal outcomes never roll over. */
const STALE_FROM = ['Applied', 'In Progress'];
const STALE_DAYS = Number(conf('staleDays', 30)) || 30;

const FIELDS = ['id', 'company', 'title', 'location', 'jobType', 'experience',
                'skills', 'platform', 'url', 'resume', 'status', 'appliedDate',
                'statusUpdatedAt', 'notes'];

const LS = {
  jobs:     'jt.jobs',
  lists:    'jt.lists',
  endpoint: 'jt.endpoint',
  theme:    'jt.theme',
};

/* ─────────────────────────── state ─────────────────────────── */

const state = {
  jobs: [],
  lists: { titles: [], locations: [], companies: [], resumes: [] },
  endpoint: '',
  endpointFromConfig: '',        // whatever config.js supplies
  endpointOverridden: false,     // true once Settings has saved a value
  transport: '',                 // '' | 'fetch' | 'jsonp' — settled on first call
  sort: { key: 'appliedDate', dir: -1 },
  view: 'add',
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ─────────────────────────── utils ─────────────────────────── */

const uid = () =>
  'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const css = (name) =>
  getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY = 86400000;

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / DAY);
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: '2-digit' });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` is-${kind}` : '');
}

/* ─────────────────────────── storage ───────────────────────── */

function loadLocal() {
  try { state.jobs = JSON.parse(localStorage.getItem(LS.jobs)) || []; }
  catch { state.jobs = []; }

  try {
    const l = JSON.parse(localStorage.getItem(LS.lists)) || {};
    for (const k of Object.keys(state.lists)) state.lists[k] = l[k] || [];
  } catch { /* keep defaults */ }

  /* Settings override config.js. An explicitly saved empty string counts as
     an override too, so clearing the field really does disconnect. */
  const saved = localStorage.getItem(LS.endpoint);
  state.endpointFromConfig = String(conf('sheetsUrl', '')).trim();
  state.endpointOverridden = saved !== null;
  state.endpoint = state.endpointOverridden ? saved : state.endpointFromConfig;
}

function saveLocal() {
  localStorage.setItem(LS.jobs, JSON.stringify(state.jobs));
  localStorage.setItem(LS.lists, JSON.stringify(state.lists));
}

/** Union of the user's saved list and every value already in the data. */
function optionsFor(listKey) {
  const fromJobs = {
    titles:    (j) => j.title,
    locations: (j) => j.location,
    companies: (j) => j.company,
    resumes:   (j) => j.resume,
  }[listKey];

  const set = new Map();
  for (const v of state.lists[listKey] || []) {
    if (v) set.set(v.toLowerCase(), v);
  }
  for (const j of state.jobs) {
    const v = fromJobs?.(j);
    if (v) set.set(String(v).toLowerCase(), String(v));
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

function rememberValue(listKey, value) {
  const v = String(value || '').trim();
  if (!v) return;
  const list = state.lists[listKey] ||= [];
  if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
}

function forgetValue(listKey, value) {
  const list = state.lists[listKey] || [];
  state.lists[listKey] = list.filter((x) => x.toLowerCase() !== value.toLowerCase());
  saveLocal();
}

/* ─────────────────────── Google Sheets API ─────────────────── */
/* Apps Script /exec sets CORS headers on its response; we POST as
   text/plain so the browser never sends a preflight it can't answer. */

/** JSONP: a <script> tag is exempt from CORS, so this works from file:// too. */
function jsonpCall(params, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(state.endpoint); }
    catch { return reject(new Error('That endpoint is not a valid URL.')); }

    const cb = '__jt_cb_' + (jsonpCall._n = (jsonpCall._n || 0) + 1);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('callback', cb);

    if (url.href.length > 7500) {
      return reject(new Error('Request too large for the fallback transport.'));
    }

    const script = document.createElement('script');
    const finish = (fn) => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      fn();
    };
    const timer = setTimeout(() => finish(() =>
      reject(new Error('Google Sheets did not respond within 25s.'))), timeoutMs);

    window[cb] = (data) => finish(() =>
      data && data.ok ? resolve(data) : reject(new Error((data && data.error) || 'Unknown Sheets error')));

    script.onerror = () => finish(() => reject(new Error(
      'Could not reach the Apps Script URL. Check that it ends in /exec and that the ' +
      'deployment’s "Who has access" is set to Anyone.')));

    script.src = url.href;
    document.head.appendChild(script);
  });
}

const api = {
  get configured() { return !!state.endpoint; },

  /** POST as text/plain so the browser never sends a preflight Apps Script can't answer. */
  async fetchCall(payload) {
    let res;
    try {
      res = await fetch(state.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });
    } catch (err) {
      // TypeError here means CORS/network — the response was never readable.
      const e = new Error('blocked');
      e.corsLike = true;
      throw e;
    }
    if (!res.ok) throw new Error(`Google Sheets responded ${res.status}. ` +
      (res.status === 401 || res.status === 403
        ? 'Redeploy the web app with "Who has access: Anyone".'
        : 'Check the Apps Script execution log.'));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown Sheets error');
    return data;
  },

  /** Same call over JSONP, chunking upserts to stay under the URL length cap. */
  async jsonpCall(payload) {
    if (payload.action === 'upsert') {
      const rows = payload.rows || [];
      let acc = { ok: true, appended: 0, updated: 0 };
      for (let i = 0; i < rows.length; i += 5) {
        const part = await jsonpCall({
          action: 'upsert',
          payload: JSON.stringify({ rows: rows.slice(i, i + 5) }),
        });
        acc.appended += part.appended || 0;
        acc.updated += part.updated || 0;
      }
      return acc;
    }
    return jsonpCall({ action: payload.action, payload: JSON.stringify(payload) });
  },

  async call(payload) {
    if (!state.endpoint) throw new Error('No Google Sheets endpoint configured.');

    if (state.transport !== 'jsonp') {
      try {
        const data = await api.fetchCall(payload);
        state.transport = 'fetch';
        return data;
      } catch (err) {
        if (!err.corsLike) throw err;          // a real error from the script — surface it
        state.transport = 'jsonp';             // CORS blocked us; switch for good
        console.info('Job Tracker: fetch was blocked, falling back to JSONP.');
      }
    }
    return api.jsonpCall(payload);
  },

  ping()          { return api.call({ action: 'ping' }); },
  list()          { return api.call({ action: 'list' }); },
  upsert(rows)    { return api.call({ action: 'upsert', rows }); },
  remove(id)      { return api.call({ action: 'delete', id }); },
};

function setSyncPill(kind, text) {
  const pill = $('#syncPill');
  pill.className = 'pill ' + ({ live: 'pill-live', err: 'pill-err' }[kind] || 'pill-muted');
  pill.textContent = text;
}

/** Fetch the sheet and make it the source of truth. */
async function pullFromSheets({ quiet = false } = {}) {
  if (!api.configured) { setSyncPill('muted', 'Local only'); return; }
  setSyncPill('muted', 'Syncing…');
  try {
    const { rows } = await api.list();
    state.jobs = (rows || []).map(normalize);
    applyStaleRule();
    saveLocal();
    renderAll();
    setSyncPill('live', 'Google Sheets');
    if (!quiet) toast(`Loaded ${state.jobs.length} row${state.jobs.length === 1 ? '' : 's'} from Sheets`);
  } catch (err) {
    setSyncPill('err', 'Sync failed');
    if (!quiet) toast('Sheets: ' + err.message, 4000);
    console.error(err);
  }
}

/** Write one row through to the sheet; keep a dirty flag if it fails. */
async function pushRow(job) {
  if (!api.configured) return;
  try {
    await api.upsert([serialize(job)]);
    delete job._dirty;
    saveLocal();
    setSyncPill('live', 'Google Sheets');
  } catch (err) {
    job._dirty = true;
    saveLocal();
    setSyncPill('err', 'Sync failed');
    toast('Saved locally — Sheets sync failed: ' + err.message, 4000);
  }
}

function normalize(row) {
  const j = {};
  for (const f of FIELDS) j[f] = row[f] ?? '';
  j.id ||= uid();
  j.status = STATUSES.includes(j.status) ? j.status : 'Applied';
  j.appliedDate = row.appliedDate ? new Date(row.appliedDate).toISOString() : new Date().toISOString();
  j.statusUpdatedAt = row.statusUpdatedAt
    ? new Date(row.statusUpdatedAt).toISOString()
    : j.appliedDate;
  return j;
}

const serialize = (j) => {
  const out = {};
  for (const f of FIELDS) out[f] = j[f] ?? '';
  return out;
};

/* ───────────────────── 30-day stale rule ───────────────────── */
/* Runs on every load. statusUpdatedAt is deliberately NOT reset, so
   "days idle" keeps telling the truth about how old the row really is. */

function applyStaleRule() {
  let changed = 0;
  for (const j of state.jobs) {
    if (STALE_FROM.includes(j.status) && daysSince(j.statusUpdatedAt) > STALE_DAYS) {
      j.status = 'No Reply';
      j._dirty = true;
      changed++;
    }
  }
  if (changed) {
    saveLocal();
    toast(`${changed} application${changed === 1 ? '' : 's'} moved to "No Reply" after ${STALE_DAYS} days`, 4200);
    if (api.configured) {
      api.upsert(state.jobs.filter((j) => j._dirty).map(serialize))
        .then(() => {
          state.jobs.forEach((j) => delete j._dirty);
          saveLocal();
        })
        .catch(() => setSyncPill('err', 'Sync failed'));
    }
  }
  return changed;
}

/* ─────────────────────────── theme ─────────────────────────── */
/* The inline script in index.html has already resolved and applied a theme
   before first paint; this only handles switching it afterwards. Charts read
   their colours from CSS variables at draw time, so a switch needs a redraw. */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, { persist = true } = {}) {
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) localStorage.setItem(LS.theme, theme);
  $('#themeBtn').title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  if (state.view === 'dashboard') renderDashboard();
}

function initTheme() {
  applyTheme(currentTheme(), { persist: false });

  $('#themeBtn').addEventListener('click', () =>
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));

  // Follow the OS only until the user picks a side.
  media.addEventListener('change', (e) => {
    if (!localStorage.getItem(LS.theme)) applyTheme(e.matches ? 'dark' : 'light', { persist: false });
  });
}

/* ─────────────────────────── routing ───────────────────────── */

function openSidebar(open) {
  $('#sidebar').classList.toggle('is-open', open);
  $('#scrim').hidden = !open;
  $('#hamburger').setAttribute('aria-expanded', String(open));
}

function go(view) {
  state.view = view;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  openSidebar(false);
  if (view === 'dashboard') renderDashboard();
  if (view === 'tracker') renderTable();
  window.scrollTo({ top: 0 });
}

/* ─────────────────────────── combobox ──────────────────────── */
/* LinkedIn-skills behaviour: filter what you already have, or commit a
   brand-new value that is then remembered for next time. */

function initCombobox(wrap) {
  const input = $('input', wrap);
  const listKey = wrap.dataset.list;
  let panel = null;
  let cursor = -1;

  const close = () => { panel?.remove(); panel = null; cursor = -1; };

  function open() {
    const q = input.value.trim().toLowerCase();
    const all = optionsFor(listKey);
    const hits = q ? all.filter((o) => o.toLowerCase().includes(q)) : all;
    const isNew = q && !all.some((o) => o.toLowerCase() === q);

    close();
    if (!hits.length && !isNew) {
      panel = document.createElement('div');
      panel.className = 'combo-panel';
      panel.innerHTML = `<div class="combo-none">No saved ${esc(listKey)} yet — just type one.</div>`;
      wrap.appendChild(panel);
      return;
    }

    panel = document.createElement('div');
    panel.className = 'combo-panel';
    panel.setAttribute('role', 'listbox');

    if (isNew) {
      const el = document.createElement('div');
      el.className = 'combo-opt is-new';
      el.dataset.value = input.value.trim();
      el.innerHTML = `＋ Add “${esc(input.value.trim())}”`;
      panel.appendChild(el);
    }

    for (const o of hits.slice(0, 60)) {
      const el = document.createElement('div');
      el.className = 'combo-opt';
      el.dataset.value = o;
      el.innerHTML = `<span>${esc(o)}</span><span class="x" data-remove="${esc(o)}" title="Remove from list">×</span>`;
      panel.appendChild(el);
    }
    wrap.appendChild(panel);
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', open);

  input.addEventListener('keydown', (e) => {
    const opts = panel ? $$('.combo-opt', panel) : [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!panel) return open();
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('is-cursor', i === cursor));
      opts[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (panel && cursor >= 0) {
        e.preventDefault();
        input.value = opts[cursor].dataset.value;
        close();
      } else {
        close();
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  wrap.addEventListener('mousedown', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      e.preventDefault(); e.stopPropagation();
      forgetValue(listKey, rm.dataset.remove);
      open();
      return;
    }
    const opt = e.target.closest('.combo-opt');
    if (opt) {
      e.preventDefault();
      input.value = opt.dataset.value;
      close();
      input.focus();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) close();
  });
}

/* ─────────────────────────── chips editor ──────────────────── */
/* Multi-value field stored as a comma-joined string, so it stays one
   plain cell in the sheet and one column in the CSV. */

const chips = (() => {
  const store = new Map();    // container id -> string[]

  const list = (id) => store.get(id) || [];

  function paint(id) {
    const wrap = document.getElementById(id);
    const input = $('input', wrap);
    $$('.chip', wrap).forEach((c) => c.remove());
    for (const [i, v] of list(id).entries()) {
      const el = document.createElement('span');
      el.className = 'chip';
      el.innerHTML = `${esc(v)}<button type="button" class="chip-x" data-i="${i}"
                        aria-label="Remove ${esc(v)}">&times;</button>`;
      wrap.insertBefore(el, input);
    }
  }

  function add(id, raw) {
    const items = String(raw || '').split(/[,;\n]/);
    const cur = list(id);
    for (const item of items) {
      const v = item.trim();
      if (!v) continue;
      if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) cur.push(v);
    }
    store.set(id, cur);
    paint(id);
  }

  function set(id, value) {
    store.set(id, []);
    if (value) add(id, value);
    else paint(id);
  }

  function init(id) {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const input = $('input', wrap);
    store.set(id, []);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();               // Enter must not submit the form
        add(id, input.value);
        input.value = '';
      } else if (e.key === 'Backspace' && !input.value && list(id).length) {
        list(id).pop();
        paint(id);
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) { add(id, input.value); input.value = ''; }
    });
    // Pasting a comma-separated list should become chips, not one long chip.
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (/[,;\n]/.test(text)) { e.preventDefault(); add(id, text); }
    });
    wrap.addEventListener('click', (e) => {
      const x = e.target.closest('.chip-x');
      if (x) {
        const cur = list(id);
        cur.splice(Number(x.dataset.i), 1);
        paint(id);
        return;
      }
      if (e.target === wrap) input.focus();
    });
  }

  return { init, set, add, value: (id) => list(id).join(', ') };
})();

/** Table cell: first few skills as chips, the rest as a count. */
function skillsCell(job) {
  const all = String(job.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!all.length) return '<span class="cell-muted">—</span>';
  const shown = all.slice(0, 3).map((s) => `<span class="chip chip-sm">${esc(s)}</span>`).join('');
  const rest = all.length - 3;
  return shown + (rest > 0
    ? `<span class="chip chip-sm chip-more" title="${esc(all.join(', '))}">+${rest}</span>`
    : '');
}

/* ─────────────────────────── add / edit form ───────────────── */

function readForm() {
  const v = (id) => $(id).value.trim();
  return {
    id: v('#f_id'),
    company: v('#f_company'),
    title: v('#f_title'),
    location: v('#f_location'),
    jobType: v('#f_jobType'),
    experience: v('#f_experience'),
    skills: chips.value('skillChips'),
    platform: v('#f_platform'),
    url: v('#f_url'),
    resume: v('#f_resume'),
    status: v('#f_status') || 'Applied',
    notes: v('#f_notes'),
    appliedDateInput: v('#f_appliedDate'),
  };
}

function resetForm() {
  $('#jobForm').reset();
  $('#f_id').value = '';
  chips.set('skillChips', '');
  $('#f_status').value = 'Applied';
  $('#appliedDateWrap').hidden = true;
  $('#submitBtn').textContent = 'Add job';
  setMsg($('#formMsg'), '');
}

function editJob(id) {
  const j = state.jobs.find((x) => x.id === id);
  if (!j) return;
  $('#f_id').value = j.id;
  $('#f_company').value = j.company;
  $('#f_title').value = j.title;
  $('#f_location').value = j.location;
  $('#f_jobType').value = JOB_TYPES.includes(j.jobType) ? j.jobType : '';
  $('#f_experience').value = j.experience;
  chips.set('skillChips', j.skills);
  $('#f_platform').value = PLATFORMS.includes(j.platform) ? j.platform : '';
  $('#f_url').value = j.url;
  $('#f_resume').value = j.resume;
  $('#f_status').value = j.status;
  $('#f_notes').value = j.notes;
  $('#f_appliedDate').value = toLocalInput(j.appliedDate);
  $('#appliedDateWrap').hidden = false;
  $('#submitBtn').textContent = 'Save changes';
  setMsg($('#formMsg'), `Editing ${j.company} — ${j.title}`);
  go('add');
}

function onSubmit(e) {
  e.preventDefault();
  const f = readForm();
  const now = new Date().toISOString();

  // Remote roles may legitimately have "Remote" / any text as their location.
  if (f.jobType === 'Remote' && !f.location) f.location = 'Remote';

  let job;
  if (f.id) {
    job = state.jobs.find((x) => x.id === f.id);
    if (!job) return;
    const statusChanged = job.status !== f.status;
    Object.assign(job, {
      company: f.company, title: f.title, location: f.location,
      jobType: f.jobType, experience: f.experience, skills: f.skills,
      platform: f.platform, url: f.url, resume: f.resume,
      status: f.status, notes: f.notes,
    });
    if (f.appliedDateInput) job.appliedDate = new Date(f.appliedDateInput).toISOString();
    if (statusChanged) job.statusUpdatedAt = now;
  } else {
    job = {
      id: uid(),
      company: f.company, title: f.title, location: f.location,
      jobType: f.jobType, experience: f.experience, skills: f.skills,
      platform: f.platform, url: f.url, resume: f.resume,
      status: f.status, notes: f.notes,
      appliedDate: now,          // ← auto-stamped
      statusUpdatedAt: now,
    };
    state.jobs.push(job);
  }

  rememberValue('titles', job.title);
  rememberValue('locations', job.location);
  rememberValue('companies', job.company);
  rememberValue('resumes', job.resume);

  saveLocal();
  renderAll();
  setMsg($('#formMsg'), f.id ? 'Saved.' : `Added — applied ${fmtDateTime(job.appliedDate)}`, 'ok');
  pushRow(job);
  if (!f.id) {
    const keep = { company: job.company };
    resetForm();
    $('#f_company').value = keep.company;   // batching applications at one company
  }
}

/* ────────────────── job-description parsing ────────────────── */
/* Fills the form and nothing else — no row is created until you press
   "Add job", and "Undo fill" restores exactly what was there before. */

const JD_TARGETS = [
  ['company',    '#f_company',    'Company'],
  ['title',      '#f_title',      'Job title'],
  ['location',   '#f_location',   'Location'],
  ['jobType',    '#f_jobType',    'Job type'],
  ['experience', '#f_experience', 'Experience'],
  ['platform',   '#f_platform',   'Platform'],
  ['url',        '#f_url',        'URL'],
];

let jdSnapshot = null;

function snapshotForm() {
  const snap = { skills: chips.value('skillChips') };
  for (const [key, sel] of JD_TARGETS) snap[key] = $(sel).value;
  return snap;
}

function restoreForm(snap) {
  for (const [key, sel] of JD_TARGETS) $(sel).value = snap[key] ?? '';
  chips.set('skillChips', snap.skills || '');
}

function initJd() {
  const panel = $('#jdPanel');
  const msg = $('#jdMsg');
  const report = $('#jdReport');

  /* Ask the server what it's set up with, so the panel says up front
     whether this can work rather than failing on click. */
  $('#jdNote').textContent = 'checking…';
  $('#jdParse').disabled = true;
  JT_AI.status().then((s) => {
    if (s.ready) {
      $('#jdNote').textContent = `via ${esc(s.model)}`;
      $('#jdParse').disabled = false;
    } else {
      $('#jdNote').textContent = 'not configured';
      report.innerHTML = `<p class="jd-hint">${esc(s.reason)}</p>`;
      report.hidden = false;
    }
  });

  $('#jdClear').addEventListener('click', () => {
    $('#jdText').value = '';
    setMsg(msg, '');
    report.hidden = true;
  });

  $('#jdUndo').addEventListener('click', () => {
    if (!jdSnapshot) return;
    restoreForm(jdSnapshot);
    jdSnapshot = null;
    $('#jdUndo').hidden = true;
    report.hidden = true;
    setMsg(msg, 'Reverted to what you had before.');
  });

  $('#jdParse').addEventListener('click', async () => {
    const text = $('#jdText').value;
    const btn = $('#jdParse');

    btn.disabled = true;
    setMsg(msg, 'Reading the posting…');
    report.hidden = true;

    try {
      const { fields, truncated } = await JT_AI.parseJobDescription(text, {
        titles: optionsFor('titles'),
        locations: optionsFor('locations'),
      });

      jdSnapshot = snapshotForm();

      const filled = [];
      const skipped = [];

      for (const [key, sel, label] of JD_TARGETS) {
        const value = fields[key];
        if (!value) { skipped.push(label); continue; }
        const el = $(sel);
        if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === value)) {
          skipped.push(label);
          continue;
        }
        el.value = value;
        el.classList.add('was-filled');
        setTimeout(() => el.classList.remove('was-filled'), 1800);
        filled.push(label);
      }

      if (fields.skills.length) {
        chips.set('skillChips', fields.skills.join(', '));
        filled.push(`Skills (${fields.skills.length})`);
      } else {
        skipped.push('Skills');
      }

      /* A remote role with no city named still has a usable location. */
      if (fields.jobType === 'Remote' && !$('#f_location').value) {
        $('#f_location').value = 'Remote';
      }

      $('#jdUndo').hidden = false;
      report.innerHTML =
        `<p class="jd-ok">Filled: ${filled.length ? esc(filled.join(', ')) : 'nothing'}</p>` +
        (skipped.length
          ? `<p class="jd-hint">Not stated in the posting, left for you: ${esc(skipped.join(', '))}</p>`
          : '') +
        (truncated
          ? '<p class="jd-hint">The posting was long, so only the first part was sent.</p>'
          : '') +
        '<p class="jd-hint">Check it before submitting — extraction is a guess, not a source of truth.</p>';
      report.hidden = false;
      setMsg(msg, `Filled ${filled.length} field${filled.length === 1 ? '' : 's'}.`, 'ok');
      panel.open = false;
    } catch (err) {
      setMsg(msg, err.message, 'err');
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ─────────────────────────── table ─────────────────────────── */

function statusBadge(job) {
  const meta = STATUS_META[job.status] || STATUS_META['Applied'];
  const opts = STATUSES.map(
    (s) => `<option value="${s}"${s === job.status ? ' selected' : ''}>${s}</option>`).join('');
  return `<span class="badge ${meta.cls}">
            <select data-status-for="${job.id}" aria-label="Status">${opts}</select>
          </span>`;
}

function visibleJobs() {
  const q = $('#search').value.trim().toLowerCase();
  const fs = $('#filterStatus').value;
  const ft = $('#filterType').value;

  let rows = state.jobs.filter((j) => {
    if (fs && j.status !== fs) return false;
    if (ft && j.jobType !== ft) return false;
    if (!q) return true;
    return [j.company, j.title, j.location, j.platform, j.resume, j.experience,
            j.skills, j.notes]
      .join(' ').toLowerCase().includes(q);
  });

  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    let av = a[key] ?? '', bv = b[key] ?? '';
    if (key === 'appliedDate' || key === 'statusUpdatedAt') {
      av = Date.parse(av) || 0; bv = Date.parse(bv) || 0;
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
  return rows;
}

function renderTable() {
  const rows = visibleJobs();
  const body = $('#jobsBody');

  body.innerHTML = rows.map((j) => {
    const idle = daysSince(j.statusUpdatedAt);
    const idleCls = STALE_FROM.includes(j.status) && idle >= STALE_DAYS - 7 ? 'idle-warn' : 'cell-muted';
    const link = j.url
      ? `<a class="link" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>`
      : '<span class="cell-muted">—</span>';

    const cell = (field, value, cls = '') =>
      `<td class="${cls}"><span class="editable" data-edit="${field}" data-id="${j.id}"
         >${esc(value) || '<span class="cell-muted">—</span>'}</span></td>`;

    return `<tr data-id="${j.id}">
      ${cell('company', j.company, 'cell-strong')}
      ${cell('title', j.title)}
      ${cell('location', j.location)}
      <td>${esc(j.jobType) || '<span class="cell-muted">—</span>'}</td>
      ${cell('experience', j.experience, 'cell-muted')}
      <td class="cell-skills">${skillsCell(j)}</td>
      <td class="cell-muted">${esc(j.platform) || '—'}</td>
      <td>${statusBadge(j)}</td>
      <td class="cell-num cell-muted" title="${esc(fmtDateTime(j.appliedDate))}">${fmtDate(j.appliedDate)}</td>
      <td class="cell-num ${idleCls}">${idle}d</td>
      ${cell('resume', j.resume, 'cell-muted')}
      <td>${link}</td>
      <td class="cell-actions">
        <button class="btn btn-ghost btn-icon" data-act="edit" data-id="${j.id}">Edit</button>
        <button class="btn btn-ghost btn-icon" data-act="del" data-id="${j.id}">✕</button>
      </td>
    </tr>`;
  }).join('');

  $('#emptyState').hidden = rows.length > 0;
  $('#emptyState').textContent = state.jobs.length
    ? 'No applications match these filters.'
    : 'No applications yet. Add one from the sidebar.';

  const dirty = state.jobs.filter((j) => j._dirty).length;
  $('#trackerSub').textContent =
    `${rows.length} of ${state.jobs.length} application${state.jobs.length === 1 ? '' : 's'}` +
    ` · click any cell to edit` +
    (dirty ? ` · ${dirty} row(s) not yet synced` : '');

  $$('#jobsTable th[data-sort]').forEach((th) =>
    th.classList.toggle('is-sorted', th.dataset.sort === state.sort.key));
}

/** Inline cell editing. */
function startEdit(span) {
  const { edit: field, id } = span.dataset;
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  const input = document.createElement('input');
  input.className = 'cell-input';
  input.value = job[field] || '';
  span.replaceWith(input);
  input.focus();
  input.select();

  const commit = (save) => {
    input.removeEventListener('blur', onBlur);
    if (save && input.value.trim() !== (job[field] || '')) {
      job[field] = input.value.trim();
      if (field === 'title')    rememberValue('titles', job.title);
      if (field === 'location') rememberValue('locations', job.location);
      if (field === 'company')  rememberValue('companies', job.company);
      if (field === 'resume')   rememberValue('resumes', job.resume);
      saveLocal();
      pushRow(job);
      toast('Updated');
    }
    renderTable();
  };
  const onBlur = () => commit(true);

  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
}

function changeStatus(id, status) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job || job.status === status) return;
  job.status = status;
  job.statusUpdatedAt = new Date().toISOString();   // resets the 30-day clock
  saveLocal();
  renderTable();
  pushRow(job);
  toast(`${job.company} → ${status}`);
}

async function deleteJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;
  if (!confirm(`Delete ${job.company} — ${job.title}?\nThis also removes the row from your Google Sheet.`)) return;
  state.jobs = state.jobs.filter((j) => j.id !== id);
  saveLocal();
  renderAll();
  if (api.configured) {
    try { await api.remove(id); } catch (e) { toast('Sheets delete failed: ' + e.message, 4000); }
  }
}

function exportCsv() {
  const cols = ['company', 'title', 'location', 'jobType', 'experience', 'skills',
                'platform', 'status', 'appliedDate', 'statusUpdatedAt', 'resume',
                'url', 'notes'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...visibleJobs().map((j) => cols.map((c) => q(j[c])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `job-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ─────────────────────────── dashboard ─────────────────────── */

function counts() {
  const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const j of state.jobs) c[j.status] = (c[j.status] || 0) + 1;
  return c;
}

function renderDashboard() {
  const c = counts();
  const total = state.jobs.length;
  const active = c['Applied'] + c['In Progress'];
  const decided = c['Rejected'] + c['Accepted'];
  const responseRate = total ? Math.round(((total - c['Applied'] - c['No Reply']) / total) * 100) : 0;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

  const kpi = (label, value, meta, dotVar) => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-meta">${dotVar
        ? `<span class="kpi-dot" style="background:var(${dotVar})"></span>` : ''}${meta}</div>
    </div>`;

  $('#kpis').innerHTML = [
    kpi('Total applications', total, `${active} still open`, null),
    kpi('Applied', c['Applied'], `${pct(c['Applied'])}% of total`, '--st-applied'),
    kpi('In progress', c['In Progress'], `${pct(c['In Progress'])}% of total`, '--st-progress'),
    kpi('Rejected', c['Rejected'], `${pct(c['Rejected'])}% of total`, '--st-rejected'),
    kpi('Accepted', c['Accepted'], `${pct(c['Accepted'])}% of total`, '--st-accepted'),
    kpi('No reply', c['No Reply'], `idle &gt; ${STALE_DAYS} days`, '--st-noreply'),
    kpi('Response rate', responseRate + '%', 'heard back at least once', null),
    kpi('Decided', decided, 'rejected + accepted', null),
  ].join('');

  const lastApplied = state.jobs.reduce((m, j) =>
    Math.max(m, Date.parse(j.appliedDate) || 0), 0);
  $('#dashSub').textContent = total
    ? `${total} applications tracked · last submitted ${fmtDateTime(new Date(lastApplied))}`
    : 'No data yet — add your first application.';

  /* 1. by status — reserved status palette, every bar directly labeled.
     Row order is CHART_STATUS_ORDER, not STATUSES: it keeps the gray and
     gold slots from sitting next to each other, which is what the palette
     validator needs for adjacent-pair separation. */
  hbar('#chartStatus',
    CHART_STATUS_ORDER.map((s) => ({ label: s, value: c[s], color: css(STATUS_META[s].cssVar) })),
    { legend: true, unit: 'application' });

  /* 2. per month — single series, one gold hue, no legend needed */
  const byMonth = new Map();
  for (const j of state.jobs) {
    const d = new Date(j.appliedDate);
    if (isNaN(d)) continue;
    byMonth.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      (byMonth.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`) || 0) + 1);
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  vbar('#chartMonth', months.map(([k, v]) => {
    const [y, m] = k.split('-');
    return {
      label: new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'short' }),
      full: new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      value: v, color: css('--gold'),
    };
  }), { unit: 'application' });

  /* 3. top companies */
  const byCo = new Map();
  for (const j of state.jobs) if (j.company) byCo.set(j.company, (byCo.get(j.company) || 0) + 1);
  hbar('#chartCompany',
    [...byCo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
      .map(([k, v]) => ({ label: k, value: v, color: css('--gold') })),
    { unit: 'application' });

  /* 4. job type mix */
  const byType = new Map();
  for (const j of state.jobs) byType.set(j.jobType || 'Unspecified',
    (byType.get(j.jobType || 'Unspecified') || 0) + 1);
  hbar('#chartType',
    JOB_TYPES.concat([...byType.keys()].filter((k) => !JOB_TYPES.includes(k)))
      .map((k) => ({ label: k, value: byType.get(k) || 0, color: css('--gold') })),
    { unit: 'application' });
}

/* ─────────────────────────── charts ────────────────────────── */
/* Hand-built SVG: thin marks, 4px rounded data-ends anchored to the
   baseline, recessive axes, direct value labels, hover tooltips. */

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Rect with only the "data end" corners rounded. */
function barPath(x, y, w, h, r, dir) {
  r = Math.max(0, Math.min(r, dir === 'right' ? w : h, (dir === 'right' ? h : w) / 2));
  if (dir === 'right') {
    return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r}` +
           ` V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
  }
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y}` +
         ` H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function mountTip(host) {
  let tip = $('.tip', host);
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    host.appendChild(tip);
  }
  return tip;
}

function wireHover(host, marks, rows, tipHtml) {
  const tip = mountTip(host);
  marks.forEach((m, i) => {
    m.addEventListener('mouseenter', () => {
      host.classList.add('is-hovering');
      marks.forEach((x) => x.classList.remove('is-hot'));
      m.classList.add('is-hot');
      tip.innerHTML = tipHtml(rows[i]);
      tip.hidden = false;
      const hb = host.getBoundingClientRect();
      const mb = m.getBoundingClientRect();
      tip.style.left = `${mb.left - hb.left + mb.width / 2}px`;
      tip.style.top = `${mb.top - hb.top}px`;
    });
  });
  host.addEventListener('mouseleave', () => {
    host.classList.remove('is-hovering');
    marks.forEach((x) => x.classList.remove('is-hot'));
    tip.hidden = true;
  });
}

function emptyChart(host, msg = 'No data yet') {
  host.innerHTML = `<p class="empty">${esc(msg)}</p>`;
}

function hbar(sel, rows, { legend = false, unit = 'item' } = {}) {
  const host = $(sel);
  host.innerHTML = '';
  if (!rows.length || rows.every((r) => !r.value)) return emptyChart(host);

  const labelW = 104, valueW = 42, rowH = 30, barH = 14, top = 4;
  const W = 520, H = top + rows.length * rowH + 4;
  const plotW = W - labelW - valueW;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const total = rows.reduce((s, r) => s + r.value, 0);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const marks = [];

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const cy = y + rowH / 2;

    const lbl = svgEl('text', { x: labelW - 10, y: cy, 'text-anchor': 'end',
      'dominant-baseline': 'middle', class: 'ax-label' });
    lbl.textContent = r.label.length > 17 ? r.label.slice(0, 16) + '…' : r.label;
    svg.appendChild(lbl);

    // baseline track keeps zero-value rows legible
    svg.appendChild(svgEl('line', { x1: labelW, x2: labelW, y1: y + 5, y2: y + rowH - 5,
      class: 'grid-line' }));

    const w = Math.max(r.value ? 3 : 0, (r.value / max) * plotW);
    if (w) {
      const p = svgEl('path', {
        d: barPath(labelW, cy - barH / 2, w, barH, 4, 'right'),
        fill: r.color, class: 'mark',
      });
      svg.appendChild(p);
      marks.push(p);
    } else {
      marks.push(svgEl('path'));   // keep index alignment
    }

    const val = svgEl('text', { x: labelW + w + 8, y: cy,
      'dominant-baseline': 'middle', class: 'val-label' });
    val.textContent = r.value;
    svg.appendChild(val);
  });

  host.appendChild(svg);

  if (legend) {
    const el = document.createElement('div');
    el.className = 'legend';
    el.innerHTML = rows.map((r) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${r.color}"></span>${esc(r.label)}</span>`
    ).join('');
    host.appendChild(el);
  }

  wireHover(host, marks.filter((m) => m.parentNode), rows.filter((r) => r.value), (r) =>
    `<strong>${r.value}</strong> ${esc(unit)}${r.value === 1 ? '' : 's'} ·
     <span class="tip-k">${esc(r.label)}</span>
     ${total ? `<span class="tip-k"> · ${Math.round((r.value / total) * 100)}%</span>` : ''}`);
}

function vbar(sel, rows, { unit = 'item' } = {}) {
  const host = $(sel);
  host.innerHTML = '';
  if (!rows.length) return emptyChart(host);

  const W = 520, H = 210, padL = 30, padR = 8, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const rawMax = Math.max(...rows.map((r) => r.value)) || 1;
  const step = plotW / rows.length;
  const barW = Math.min(34, step - 8);

  /* Round the axis up so every tick is a whole number. */
  const ticks = Math.min(4, rawMax);
  const tickStep = Math.ceil(rawMax / ticks);
  const max = tickStep * ticks;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // recessive gridlines
  for (let t = 0; t <= ticks; t++) {
    const v = tickStep * t;
    const y = padT + plotH - (v / max) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'grid-line' }));
    const lbl = svgEl('text', { x: padL - 8, y, 'text-anchor': 'end',
      'dominant-baseline': 'middle', class: 'ax-label' });
    lbl.textContent = v;
    svg.appendChild(lbl);
  }

  const marks = [];
  rows.forEach((r, i) => {
    const cx = padL + step * i + step / 2;
    const h = Math.max(r.value ? 3 : 0, (r.value / max) * plotH);
    if (h) {
      const p = svgEl('path', {
        d: barPath(cx - barW / 2, padT + plotH - h, barW, h, 4, 'up'),
        fill: r.color, class: 'mark',
      });
      svg.appendChild(p);
      marks.push(p);
    }
    const lbl = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'ax-label' });
    lbl.textContent = r.label;
    svg.appendChild(lbl);
  });

  host.appendChild(svg);
  wireHover(host, marks, rows.filter((r) => r.value), (r) =>
    `<strong>${r.value}</strong> ${esc(unit)}${r.value === 1 ? '' : 's'} ·
     <span class="tip-k">${esc(r.full || r.label)}</span>`);
}

/** Tell the user which of the two sources the live URL came from. */
function renderEndpointSource() {
  const hint = $('#endpointSource');
  const reset = $('#resetEndpoint');
  const setup = 'See <code>gas/Code.gs</code> and the README for the 5-minute setup.';

  if (state.endpointOverridden && state.endpointFromConfig) {
    hint.innerHTML = 'Saved in this browser, overriding <code>config.js</code>.';
    reset.hidden = false;
  } else if (state.endpointOverridden) {
    hint.innerHTML = `Saved in this browser. To bake it into the code instead, set ` +
                     `<code>sheetsUrl</code> in <code>config.js</code>.`;
    reset.hidden = true;
  } else if (state.endpointFromConfig) {
    hint.innerHTML = 'Loaded from <code>config.js</code> — nothing to paste.';
    reset.hidden = true;
  } else {
    hint.innerHTML = `${setup} You can also set <code>sheetsUrl</code> in ` +
                     `<code>config.js</code> to skip this field entirely.`;
    reset.hidden = true;
  }
}

/* ─────────────────────────── diagnostics ───────────────────── */
/* "Failed to fetch" tells you nothing on its own, so check the things
   that actually go wrong, in order, and report each one. */

async function runDiagnostics() {
  const out = $('#diagnostics');
  const msg = $('#settingsMsg');
  const url = $('#f_endpoint').value.trim();
  state.endpoint = url;
  state.transport = '';

  const lines = [];
  const say = (ok, text) => {
    lines.push(`<li class="${ok === null ? 'dg-warn' : ok ? 'dg-ok' : 'dg-bad'}">` +
               `<span>${ok === null ? '!' : ok ? '✓' : '✕'}</span><span>${text}</span></li>`);
    out.innerHTML = `<ul class="diag">${lines.join('')}</ul>`;
    out.hidden = false;
  };

  setMsg(msg, 'Running checks…');
  out.innerHTML = '';
  out.hidden = false;

  /* 1. the URL itself */
  if (!url) {
    say(false, 'No URL entered.');
    return setMsg(msg, 'Paste your Apps Script /exec URL first.', 'err');
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    say(false, 'That is not a valid URL.');
    return setMsg(msg, 'Check the URL.', 'err');
  }
  if (!/^script\.google\.com$/.test(parsed.hostname)) {
    say(null, `Host is <code>${esc(parsed.hostname)}</code>, expected <code>script.google.com</code>.`);
  } else {
    say(true, 'URL host looks right.');
  }
  if (parsed.pathname.endsWith('/dev')) {
    say(false, 'This is the <code>/dev</code> test URL — it only works while you are signed in. ' +
               'Use the <code>/exec</code> URL from Deploy ▸ Manage deployments.');
  } else if (parsed.pathname.endsWith('/exec')) {
    say(true, 'URL ends in <code>/exec</code>.');
  } else {
    say(null, 'URL does not end in <code>/exec</code> — copy it from Deploy ▸ Manage deployments.');
  }

  /* 2. how the page itself is being served */
  if (location.protocol === 'file:') {
    say(null, 'Page is opened from <code>file://</code>, so normal requests are blocked by ' +
              'the browser. The JSONP fallback handles this — or serve the folder over http.');
  } else {
    say(true, `Page served over <code>${esc(location.protocol)}//</code>.`);
  }

  /* 3. the actual round trip */
  try {
    const t0 = performance.now();
    const res = await api.ping();
    const ms = Math.round(performance.now() - t0);
    say(true, `Reached the script via <strong>${state.transport}</strong> in ${ms}ms.`);
    if (res.sheet) say(true, `Connected to spreadsheet “${esc(res.sheet)}”.`);
  } catch (err) {
    if (/Unknown action: ping/i.test(err.message)) {
      say(false, 'The deployed script is an older copy of <code>Code.gs</code>. Re-paste the ' +
                 'current file, then Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version.');
      return setMsg(msg, 'Script is out of date — redeploy a new version.', 'err');
    }
    say(false, esc(err.message));
    say(null, 'Most common cause: the deployment’s <strong>Who has access</strong> is not set to ' +
              '<strong>Anyone</strong>. Deploy ▸ Manage deployments ▸ ✏️ ▸ change it ▸ Deploy.');
    setSyncPill('err', 'Sync failed');
    return setMsg(msg, 'Could not reach the script.', 'err');
  }

  /* 4. read the data */
  try {
    const { rows } = await api.list();
    say(true, `Read ${rows.length} row(s) from the <code>Applications</code> tab.`);
    setSyncPill('live', 'Google Sheets');
    setMsg(msg, 'Connected. Hit "Save & connect" to start syncing.', 'ok');
  } catch (err) {
    say(false, 'Reached the script but reading failed: ' + esc(err.message));
    setMsg(msg, 'Script reachable, sheet read failed.', 'err');
  }
}

/* ─────────────────────────── render-all ────────────────────── */

function renderAll() {
  renderTable();
  if (state.view === 'dashboard') renderDashboard();
}

/* ─────────────────────────── wiring ────────────────────────── */

function init() {
  loadLocal();
  initTheme();
  chips.init('skillChips');
  initJd();
  $('#f_endpoint').value = state.endpoint;
  renderEndpointSource();
  $$('.combo').forEach(initCombobox);

  $('#hamburger').addEventListener('click', () =>
    openSidebar(!$('#sidebar').classList.contains('is-open')));
  $('#closeSidebar').addEventListener('click', () => openSidebar(false));
  $('#scrim').addEventListener('click', () => openSidebar(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openSidebar(false); });
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

  $('#jobForm').addEventListener('submit', onSubmit);
  $('#resetBtn').addEventListener('click', (e) => { e.preventDefault(); resetForm(); });
  $('#f_jobType').addEventListener('change', (e) => {
    const loc = $('#f_location');
    if (e.target.value === 'Remote' && !loc.value) loc.placeholder = 'Remote — or a specific city';
  });

  $('#search').addEventListener('input', renderTable);
  $('#filterStatus').addEventListener('change', renderTable);
  $('#filterType').addEventListener('change', renderTable);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#refreshBtn').addEventListener('click', () => pullFromSheets());

  $$('#jobsTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderTable();
  }));

  $('#jobsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      if (btn.dataset.act === 'edit') editJob(btn.dataset.id);
      if (btn.dataset.act === 'del') deleteJob(btn.dataset.id);
      return;
    }
    const span = e.target.closest('[data-edit]');
    if (span) startEdit(span);
  });

  $('#jobsBody').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-status-for]');
    if (sel) changeStatus(sel.dataset.statusFor, sel.value);
  });

  /* settings */
  $('#saveEndpoint').addEventListener('click', async () => {
    state.endpoint = $('#f_endpoint').value.trim();
    state.transport = '';
    localStorage.setItem(LS.endpoint, state.endpoint);
    state.endpointOverridden = true;
    renderEndpointSource();
    setMsg($('#settingsMsg'), state.endpoint ? 'Saved. Loading from Sheets…' : 'Cleared — local only.', 'ok');
    if (state.endpoint) await pullFromSheets();
    else setSyncPill('muted', 'Local only');
  });

  $('#resetEndpoint').addEventListener('click', async () => {
    localStorage.removeItem(LS.endpoint);
    state.endpointOverridden = false;
    state.endpoint = state.endpointFromConfig;
    state.transport = '';
    $('#f_endpoint').value = state.endpoint;
    renderEndpointSource();
    setMsg($('#settingsMsg'), 'Back to the URL in config.js.', 'ok');
    if (state.endpoint) await pullFromSheets();
    else setSyncPill('muted', 'Local only');
  });

  $('#testEndpoint').addEventListener('click', runDiagnostics);

  $('#pushAll').addEventListener('click', async () => {
    if (!state.jobs.length) return setMsg($('#settingsMsg'), 'Nothing to push.', 'err');
    setMsg($('#settingsMsg'), `Pushing ${state.jobs.length} row(s)…`);
    try {
      await api.upsert(state.jobs.map(serialize));
      state.jobs.forEach((j) => delete j._dirty);
      saveLocal();
      renderAll();
      setMsg($('#settingsMsg'), 'All rows pushed to Google Sheets.', 'ok');
      setSyncPill('live', 'Google Sheets');
    } catch (err) {
      setMsg($('#settingsMsg'), 'Failed: ' + err.message, 'err');
    }
  });

  $('#wipeLocal').addEventListener('click', () => {
    if (!confirm('Clear the local cache? Your Google Sheet is not touched.')) return;
    localStorage.removeItem(LS.jobs);
    state.jobs = [];
    saveLocal();
    renderAll();
    toast('Local cache cleared');
  });

  $('#staleDays').textContent = `${STALE_DAYS} days`;

  /* first paint */
  applyStaleRule();
  go('add');
  renderTable();
  if (api.configured) pullFromSheets({ quiet: true });
  else setSyncPill('muted', 'Local only');
}

document.addEventListener('DOMContentLoaded', init);
