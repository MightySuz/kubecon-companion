'use strict';

/* =====================================================================
   KubeCon Companion — schedule, capture, badge QR, debrief.
   All data lives on this device (IndexedDB). No accounts, no server.
   ===================================================================== */

const EVENT_TZ = 'America/Denver';
const EVENT_NAME = 'KubeCon + CloudNativeCon NA 2026';
const THEMES = ['Pain point', 'Feature ask', 'Competitor', 'OpenTelemetry', 'Pricing', 'Partnership', 'Hiring'];
const TAG_LABEL = { hot: 'Hot', warm: 'Warm', fyi: 'FYI' };
const DAY_ORDER = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
const PRIORITY_TRACKS = ['Observability', 'Platform Engineering', 'Keynote Sessions', 'AI Inference + Agentic'];
const TRACK_COLORS = ['#6FA8FF', '#FFC261', '#5FD6A4', '#B69CFF', '#6FE0E6', '#FF9F6F', '#E58CFF', '#A8D86F'];

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function trackColor(track) {
  if (track === 'Observability') return '#FF7A9A';
  let h = 0;
  for (const ch of track || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TRACK_COLORS[h % TRACK_COLORS.length];
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function nowInEvent() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: +parts.hour * 60 + +parts.minute };
}

const dayParts = (iso) => {
  const d = new Date(iso + 'T12:00:00Z');
  return {
    wd: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    long: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    md: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }),
    n: d.getUTCDate(),
  };
};

const shortRoom = (r) => (r || '').replace(/^(Salt Palace|Hyatt Regency)\s*\|\s*/i, '').replace(/\s*\|\s*/g, ' · ');

function stamp(ts) {
  return new Date(ts).toLocaleString('en-US', { timeZone: EVENT_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function normalizeLinkedIn(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/linkedin\.com/i.test(v)) return 'https://' + v.replace(/^\/+/, '');
  return 'https://www.linkedin.com/in/' + v.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
}

/* ---------- storage (IndexedDB) ---------- */
let dbp;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('kubecon-companion', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
const photoPut = (id, blob) => tx('photos', 'readwrite', (s) => s.put(blob, id));
const photoGet = (id) => tx('photos', 'readonly', (s) => s.get(id));
const photoDel = (id) => tx('photos', 'readwrite', (s) => s.delete(id));

/* ---------- state ---------- */
const S = {
  sessions: [], byId: new Map(),
  profile: { name: '', title: '', company: '', linkedin: '' },
  plan: [], meetings: [], contacts: [], takeaways: '',
  ui: { tab: 'schedule', day: null, planOnly: false, q: '', track: '', pq: '', pfilter: 'all' },
  draft: null,
};
const photoURLs = new Map(); // photoId -> object URL

const persist = (key) => kvSet(key, S[key]).catch(() => toast('Could not save. Storage may be full.'));

async function photoURL(id) {
  if (!id) return '';
  if (photoURLs.has(id)) return photoURLs.get(id);
  const blob = await photoGet(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  photoURLs.set(id, url);
  return url;
}

function blankDraft() {
  return { name: '', company: '', notes: '', contact: '', tag: 'warm', themes: [], nextStep: '', photoId: '', sessionId: null, sessionAuto: true };
}

/* ---------- toast & sheets ---------- */
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? `<button data-act="toast-action">${esc(action.label)}</button>` : '');
  t._action = action && action.fn;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2400);
}

function openSheet(html, { onClose } = {}) {
  closeSheet(true);
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div class="sheet-body">${html}</div></div>`;
  root._onClose = onClose;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('in-view')));
}
function closeSheet(immediate) {
  const root = $('#sheet-root');
  if (!root.firstChild) return;
  const cb = root._onClose;
  root._onClose = null;
  const clear = () => { root.innerHTML = ''; root.classList.remove('in-view'); };
  if (immediate) clear();
  else { root.classList.remove('in-view'); setTimeout(clear, 300); }
  if (cb) cb();
}

/* ---------- schedule logic ---------- */
function allItems() {
  const mine = S.meetings.map((m) => ({ ...m, mine: true, track: 'My meeting' }));
  return [...S.sessions, ...mine];
}
const itemById = (id) => S.byId.get(id) || S.meetings.find((m) => m.id === id);
const isPlanned = (id) => S.plan.includes(id);

function overlapsPlan(it) {
  if (!(it.mine || isPlanned(it.id))) return false;
  const a0 = toMin(it.start), a1 = toMin(it.end);
  return allItems().some((o) => o.id !== it.id && o.day === it.day && (o.mine || isPlanned(o.id)) && toMin(o.start) < a1 && a0 < toMin(o.end));
}

function currentContextSession() {
  const n = nowInEvent();
  const mine = allItems().filter((i) => (i.mine || isPlanned(i.id)) && i.day === n.date);
  const live = mine.find((i) => toMin(i.start) <= n.min && n.min < toMin(i.end));
  if (live) return live.id;
  const recent = mine.filter((i) => toMin(i.end) <= n.min && n.min - toMin(i.end) <= 45).sort((a, b) => toMin(b.end) - toMin(a.end))[0];
  return recent ? recent.id : null;
}

/* ---------- views ---------- */
const view = () => $('#view');

function setTab(tab) {
  S.ui.tab = tab;
  $('#toast').classList.remove('show');
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  render();
  view().scrollTop = 0;
}

function render() {
  const needsOnboarding = !S.profile.name;
  $('#tabs').style.display = needsOnboarding ? 'none' : '';
  if (needsOnboarding) return renderWelcome();
  ({ schedule: renderSchedule, people: renderPeople, capture: renderCapture, badge: renderBadge, debrief: renderDebrief }[S.ui.tab])();
  const n = S.contacts.length;
  const pc = $('#people-count');
  pc.hidden = !n;
  pc.textContent = n;
}

/* ----- welcome ----- */
function renderWelcome() {
  view().innerHTML = `
    <div class="welcome">
      <h1 class="title">KubeCon,<br>Salt Lake City.</h1>
      <p class="sub">Four days of conversations, kept in one place. Set up your badge first. It stays on this phone.</p>
      <div style="height:26px"></div>
      <label class="field"><span>Your name</span><input class="in" id="w-name" autocomplete="name" placeholder="Name on your badge"></label>
      <label class="field"><span>Title</span><input class="in" id="w-title" placeholder="Your role"></label>
      <label class="field"><span>Company</span><input class="in" id="w-company" placeholder="Company"></label>
      <label class="field"><span>LinkedIn profile</span><input class="in" id="w-li" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="linkedin.com/in/you or just your handle"></label>
      <button class="btn" data-act="welcome-save" style="margin-top:8px">Create my badge</button>
    </div>`;
}

/* ----- schedule ----- */
function renderSchedule() {
  const n = nowInEvent();
  if (!S.ui.day) S.ui.day = DAY_ORDER.includes(n.date) ? n.date : '2026-11-09';
  const items = allItems();
    const dp = dayParts(S.ui.day);
  const dayItems = items.filter((i) => i.day === S.ui.day && !i.noop);

  const trackCounts = {};
  dayItems.forEach((i) => { if (!i.noise && !i.mine) trackCounts[i.track] = (trackCounts[i.track] || 0) + 1; });
  const tracks = Object.keys(trackCounts).sort((a, b) => {
    const pa = PRIORITY_TRACKS.indexOf(a), pb = PRIORITY_TRACKS.indexOf(b);
    if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    return trackCounts[b] - trackCounts[a];
  });

  view().innerHTML = `
    <div class="head">
      <div><h1 class="title">${dp.long}</h1><p class="sub num" id="sched-sub"></p></div>
      <button class="pill-btn" data-act="add-meeting">+ Meeting</button>
    </div>
    <div class="days">${DAY_ORDER.map((d) => {
      const p = dayParts(d);
      return `<button class="day ${d === S.ui.day ? 'on' : ''} ${d === n.date ? 'today' : ''}" data-act="pick-day" data-day="${d}"><span>${p.wd}</span><b>${p.n}</b></button>`;
    }).join('')}</div>
    <div class="seg" style="margin-top:14px">
      <button class="${S.ui.planOnly ? '' : 'on'}" data-act="plan-only" data-v="0">All sessions</button>
      <button class="${S.ui.planOnly ? 'on' : ''}" data-act="plan-only" data-v="1">My plan</button>
    </div>
    <label class="search" style="margin-top:12px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="sq" type="search" enterkeyhint="search" placeholder="Search talks, speakers, rooms" value="${esc(S.ui.q)}"></label>
    <div class="chips"><button class="chip ${S.ui.track ? '' : 'on'}" data-act="pick-track" data-track="">All tracks</button>${tracks.map((t) => `<button class="chip ${S.ui.track === t ? 'on' : ''}" data-act="pick-track" data-track="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <div id="sched-list"></div>`;
  paintScheduleList();
}

function paintScheduleList() {
  const q = S.ui.q.trim().toLowerCase();
  const n = nowInEvent();
  let list = allItems().filter((i) => i.day === S.ui.day);
  if (!q && !S.ui.track) list = list.filter((i) => !i.noise);
  if (S.ui.planOnly) list = list.filter((i) => i.mine || isPlanned(i.id));
  if (S.ui.track) list = list.filter((i) => i.track === S.ui.track);
  if (q) list = list.filter((i) => `${i.title} ${i.speakers || ''} ${i.room || ''} ${i.track || ''} ${i.withWho || ''}`.toLowerCase().includes(q));
  list.sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(a.end) - toMin(b.end));

  const planned = list.filter((i) => i.mine || isPlanned(i.id)).length;
  $('#sched-sub').textContent = `${list.length} ${list.length === 1 ? 'item' : 'items'} · ${planned} in your plan`;

  if (!list.length) {
    $('#sched-list').innerHTML = S.ui.planOnly
      ? `<div class="empty"><b>Nothing in your plan yet</b>Switch to All sessions and tap the star on a talk to add it.</div>`
      : `<div class="empty"><b>No matches</b>Try a different search or track.</div>`;
    return;
  }

  const slots = new Map();
  list.forEach((i) => { if (!slots.has(i.start)) slots.set(i.start, []); slots.get(i.start).push(i); });

  $('#sched-list').innerHTML = [...slots].map(([start, arr]) => `
    <section class="slot">
      <div class="slot-time">${fmtTime(start).replace(' ', '<small>') + '</small>'}</div>
      <div class="slot-items">${arr.map((i) => {
        const live = S.ui.day === n.date && toMin(i.start) <= n.min && n.min < toMin(i.end);
        const inPlan = i.mine || isPlanned(i.id);
        return `<div class="s-card ${inPlan ? 'planned' : ''} ${i.mine ? 'mine' : ''}" style="--tc:${trackColor(i.track)}" data-act="open-item" data-id="${esc(i.id)}" role="button" tabindex="0">
          <p class="s-title">${live ? '<span class="badge-now">NOW</span>' : ''}${esc(i.title)}</p>
          <div class="s-meta"><span class="nw">${fmtTime(i.start)}–${fmtTime(i.end)}</span> · <span class="trk">${esc(i.mine ? 'Meeting' : i.track)}</span>${i.room ? ' · ' + esc(shortRoom(i.room)) : ''}${overlapsPlan(i) ? ' · <span class="badge-warn">Overlaps</span>' : ''}</div>
          ${i.mine ? '' : `<button class="s-star ${isPlanned(i.id) ? 'on' : ''}" data-act="toggle-plan" data-id="${esc(i.id)}" aria-label="${isPlanned(i.id) ? 'Remove from plan' : 'Add to plan'}"><svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z"/></svg></button>`}
        </div>`;
      }).join('')}</div>
    </section>`).join('');
}

function openItemSheet(id) {
  const it = itemById(id);
  if (!it) return;
  const dp = dayParts(it.day);
  const link = it.mine ? '' : `https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/?id=${it.id}`;
  openSheet(`
    <h3>${esc(it.title)}</h3>
    <dl class="kv">
      <dt>When</dt><dd>${dp.wd}, ${dp.md} · ${fmtTime(it.start)}–${fmtTime(it.end)}</dd>
      ${it.room ? `<dt>Where</dt><dd>${esc(shortRoom(it.room))}</dd>` : ''}
      ${it.speakers ? `<dt>Speakers</dt><dd>${esc(it.speakers)}</dd>` : ''}
      ${it.withWho ? `<dt>With</dt><dd>${esc(it.withWho)}</dd>` : ''}
      ${!it.mine ? `<dt>Track</dt><dd style="color:${trackColor(it.track)}">${esc(it.track)}</dd>` : ''}
    </dl>
    ${it.desc ? `<div class="desc">${esc(it.desc)}${it.desc.length >= 900 ? '…' : ''}</div>` : ''}
    ${link ? `<a class="link" href="${link}" target="_blank" rel="noopener">Open on the KubeCon site</a>` : ''}
    <div class="btn-row" style="margin-top:18px">
      ${it.mine
        ? `<button class="btn ghost sm" data-act="delete-meeting" data-id="${esc(it.id)}">Delete meeting</button>`
        : `<button class="btn ${isPlanned(it.id) ? 'ghost' : ''} sm" data-act="toggle-plan" data-id="${esc(it.id)}" data-close="1">${isPlanned(it.id) ? 'Remove from plan' : 'Add to plan'}</button>`}
      <button class="btn ghost sm" data-act="capture-here" data-id="${esc(it.id)}">Capture a chat here</button>
    </div>`);
}

function openMeetingSheet() {
  const n = nowInEvent();
  const day = DAY_ORDER.includes(n.date) ? n.date : S.ui.day;
  openSheet(`
    <h3>Add a meeting</h3>
    <label class="field"><span>What is it?</span><input class="in" id="m-title" placeholder="Coffee with…"></label>
    <label class="field"><span>With</span><input class="in" id="m-with" placeholder="Name, company"></label>
    <div class="row2">
      <label class="field"><span>Day</span><select class="in" id="m-day">${DAY_ORDER.map((d) => `<option value="${d}" ${d === day ? 'selected' : ''}>${dayParts(d).wd} ${dayParts(d).n}</option>`).join('')}</select></label>
      <label class="field"><span>Where</span><input class="in" id="m-room" placeholder="Optional"></label>
    </div>
    <div class="row2">
      <label class="field"><span>Starts</span><input class="in" id="m-start" type="time" value="14:00"></label>
      <label class="field"><span>Ends</span><input class="in" id="m-end" type="time" value="14:30"></label>
    </div>
    <button class="btn" data-act="save-meeting" style="margin-top:6px">Add to schedule</button>`);
}

/* ----- capture ----- */
function renderCapture() {
  if (!S.draft) S.draft = blankDraft();
  const d = S.draft;
  if (d.sessionAuto && d.sessionId === null) d.sessionId = currentContextSession() || '';
  const ctx = d.sessionId ? itemById(d.sessionId) : null;
  const thumb = d.photoId && photoURLs.get(d.photoId);

  view().innerHTML = `
    <h1 class="title">New conversation</h1>
    <p class="sub">Capture it now while it is fresh.</p>
    <div style="height:18px"></div>
    <label class="field"><span>Name</span><input class="in" id="c-name" autocomplete="off" autocapitalize="words" placeholder="Who did you meet?" value="${esc(d.name)}"></label>
    <label class="field"><span>Company</span><input class="in" id="c-company" autocomplete="off" autocapitalize="words" placeholder="Where they work" value="${esc(d.company)}"></label>
    <label class="field"><span>What you talked about</span><textarea class="ta" id="c-notes" placeholder="The topic, what they care about, anything you promised. Tap the mic on your keyboard to dictate.">${esc(d.notes)}</textarea></label>
    <div class="field"><span>Themes</span><div class="wrap-chips">${THEMES.map((t) => `<button class="chip ${d.themes.includes(t) ? 'on' : ''}" data-act="draft-theme" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
    <div class="field" style="margin-bottom:8px"><span>How warm is this lead?</span></div>
    <div class="tagpick">${['hot', 'warm', 'fyi'].map((t) => `<button class="${d.tag === t ? 'on' : ''}" data-tag="${t}" data-act="draft-tag" data-v="${t}">${TAG_LABEL[t]}</button>`).join('')}</div>
    <label class="field"><span>Contact details, if they shared them</span><input class="in" id="c-contact" autocapitalize="off" autocorrect="off" placeholder="Email, phone or LinkedIn" value="${esc(d.contact)}"></label>
    <label class="field"><span>Next step</span><input class="in" id="c-next" placeholder="Send the deck, intro to a teammate…" value="${esc(d.nextStep)}"></label>
    <div class="photo-row">
      ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : ''}
      <label class="photo-add"><svg viewBox="0 0 24 24"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.5" r="3.4"/></svg>${thumb ? 'Replace photo' : 'Add a photo'}<input id="c-photo" type="file" accept="image/*" hidden></label>
      ${thumb ? `<button class="pill-btn" data-act="draft-photo-clear">Remove</button>` : ''}
    </div>
    ${ctx ? `<div class="ctx"><span>Around <b>${esc(ctx.title)}</b></span><button data-act="draft-ctx-clear" aria-label="Remove session link">×</button></div>` : ''}
    <button class="btn" data-act="save-contact">Save conversation</button>`;
}

function readDraftInputs() {
  const g = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
  const d = S.draft;
  if (!d) return;
  const map = { 'c-name': 'name', 'c-company': 'company', 'c-notes': 'notes', 'c-contact': 'contact', 'c-next': 'nextStep' };
  for (const [id, key] of Object.entries(map)) { const v = g(id); if (v !== null) d[key] = v; }
}

async function handlePhotoFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 900, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.78));
    const id = uid();
    await photoPut(id, blob);
    photoURLs.set(id, URL.createObjectURL(blob));
    return id;
  } catch (e) {
    toast('That photo could not be read. Try another.');
  }
}

async function saveContact() {
  readDraftInputs();
  const d = S.draft;
  if (!d.name.trim()) { toast('Add their name first.'); $('#c-name')?.focus(); return; }
  const c = {
    id: uid(), createdAt: Date.now(), name: d.name.trim(), company: d.company.trim(), notes: d.notes.trim(),
    contact: d.contact.trim(), tag: d.tag, themes: d.themes, nextStep: d.nextStep.trim(), photoId: d.photoId,
    sessionId: d.sessionId || '', done: false,
  };
  S.contacts.unshift(c);
  await persist('contacts');
  S.draft = blankDraft();
  render();
  view().scrollTop = 0;
  toast(`Saved ${c.name}`, { label: 'View', fn: () => { setTab('people'); openContactSheet(c.id); } });
}

/* ----- people ----- */
async function renderPeople() {
  const f = S.ui.pfilter, q = S.ui.pq.trim().toLowerCase();
  const counts = { all: S.contacts.length, hot: 0, warm: 0, fyi: 0, open: 0 };
  S.contacts.forEach((c) => { counts[c.tag]++; if (c.tag !== 'fyi' && !c.done) counts.open++; });

  view().innerHTML = `
    <div class="head"><div><h1 class="title">People</h1><p class="sub num">${S.contacts.length} ${S.contacts.length === 1 ? 'conversation' : 'conversations'}${counts.open ? ` · ${counts.open} to follow up` : ''}</p></div></div>
    <label class="search" style="margin-top:16px"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="pq" type="search" placeholder="Search names, companies, notes" value="${esc(S.ui.pq)}"></label>
    <div class="chips">${[['all', 'All'], ['hot', 'Hot'], ['warm', 'Warm'], ['fyi', 'FYI'], ['open', 'To follow up']].map(([k, l]) => `<button class="chip ${k !== 'all' && k !== 'open' ? k : ''} ${f === k ? 'on' : ''}" data-act="pick-pfilter" data-v="${k}">${l}</button>`).join('')}</div>
    <div id="people-list"></div>`;
  await paintPeople();
}

async function paintPeople() {
  const f = S.ui.pfilter, q = S.ui.pq.trim().toLowerCase();
  let list = S.contacts.filter((c) => (f === 'all' ? true : f === 'open' ? c.tag !== 'fyi' && !c.done : c.tag === f));
  if (q) list = list.filter((c) => `${c.name} ${c.company} ${c.notes} ${c.contact} ${c.themes.join(' ')}`.toLowerCase().includes(q));
  const host = $('#people-list');
  if (!host) return;
  if (!list.length) {
    host.innerHTML = S.contacts.length
      ? `<div class="empty"><b>No matches</b>Try a different filter.</div>`
      : `<div class="empty"><b>No conversations yet</b>Tap the pink + to capture your first one.</div>`;
    return;
  }
  const urls = await Promise.all(list.map((c) => photoURL(c.photoId)));
  host.innerHTML = list.map((c, i) => `
    <button class="p-row" data-act="open-contact" data-id="${c.id}">
      ${urls[i] ? `<img class="avatar" src="${urls[i]}" alt="">` : `<div class="avatar">${esc(initials(c.name))}</div>`}
      <div class="p-main">
        <div class="p-name ${c.done ? 'done' : ''}">${esc(c.name)}${c.company ? ` <span class="p-co">· ${esc(c.company)}</span>` : ''}</div>
        <div class="p-note">${esc(c.notes || c.nextStep || stamp(c.createdAt))}</div>
      </div>
      <span class="tag ${c.tag}">${TAG_LABEL[c.tag]}</span>
    </button>`).join('');
}

async function openContactSheet(id) {
  const c = S.contacts.find((x) => x.id === id);
  if (!c) return;
  const url = await photoURL(c.photoId);
  const sess = c.sessionId ? itemById(c.sessionId) : null;
  openSheet(`
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:6px">
      ${url ? `<img class="avatar" style="width:64px;height:64px;border-radius:20px" src="${url}" alt="">` : `<div class="avatar" style="width:64px;height:64px;border-radius:20px;font-size:22px">${esc(initials(c.name))}</div>`}
      <div style="min-width:0"><h3 style="margin:0">${esc(c.name)}</h3><div class="muted">${esc(c.company || 'No company')} · ${stamp(c.createdAt)}</div></div>
    </div>
    <div class="tagpick" style="margin-top:14px">${['hot', 'warm', 'fyi'].map((t) => `<button class="${c.tag === t ? 'on' : ''}" data-tag="${t}" data-act="contact-tag" data-id="${c.id}" data-v="${t}">${TAG_LABEL[t]}</button>`).join('')}</div>
    <label class="field"><span>Notes</span><textarea class="ta" id="e-notes" style="min-height:110px">${esc(c.notes)}</textarea></label>
    <label class="field"><span>Contact details</span><input class="in" id="e-contact" autocapitalize="off" value="${esc(c.contact)}"></label>
    <label class="field"><span>Next step</span><input class="in" id="e-next" value="${esc(c.nextStep)}"></label>
    <div class="field"><span>Themes</span><div class="wrap-chips">${THEMES.map((t) => `<button class="chip ${c.themes.includes(t) ? 'on' : ''}" data-act="contact-theme" data-id="${c.id}" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
    ${sess ? `<div class="ctx"><span>Around <b>${esc(sess.title)}</b></span></div>` : ''}
    ${c.tag !== 'fyi' ? `<button class="btn ${c.done ? 'ghost' : ''} sm" data-act="contact-done" data-id="${c.id}" style="margin-bottom:10px">${c.done ? 'Reopen follow-up' : 'Mark follow-up done'}</button>` : ''}
    <div class="btn-row">
      <button class="btn ghost sm" data-act="contact-vcard" data-id="${c.id}">Save to Contacts</button>
      <button class="btn danger sm" data-act="contact-delete" data-id="${c.id}">Delete</button>
    </div>
    <button class="btn sm" data-act="contact-save" data-id="${c.id}" style="margin-top:10px">Save changes</button>`);
}

function contactFromSheet(id) {
  const c = S.contacts.find((x) => x.id === id);
  if (!c) return null;
  c.notes = $('#e-notes').value.trim();
  c.contact = $('#e-contact').value.trim();
  c.nextStep = $('#e-next').value.trim();
  return c;
}

/* ----- badge ----- */
function qrSVG(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function renderBadge() {
  const p = S.profile;
  const url = normalizeLinkedIn(p.linkedin);
  view().innerHTML = `
    <div class="badge-wrap">
      <div class="head"><div><h1 class="title">My QR</h1><p class="sub">Hold it out. They scan, they land on your LinkedIn.</p></div></div>
      <div class="badge">
        <div class="badge-top"><span><i class="dot"></i>${esc(EVENT_NAME)}</span></div>
        <h2 class="badge-name">${esc(p.name)}</h2>
        <div class="badge-role">${esc([p.title, p.company].filter(Boolean).join(' · '))}</div>
        ${url
          ? `<div class="qr-tile" data-act="qr-full" role="button" aria-label="Show QR full screen">${qrSVG(url)}</div><div class="qr-cap">${esc(url.replace(/^https?:\/\/(www\.)?/, ''))}</div>`
          : `<div class="qr-empty">Add your LinkedIn profile to show a QR code here.</div>`}
        <div class="badge-foot"><span>Salt Lake City</span><span>Nov 9–12, 2026</span></div>
      </div>
      <div class="btn-row" style="margin-top:18px">
        ${url ? `<button class="btn sm" data-act="qr-full">Show full screen</button>` : ''}
        <button class="btn ghost sm" data-act="edit-profile">${url ? 'Edit' : 'Add LinkedIn'}</button>
      </div>
      ${url ? `<button class="btn ghost sm" data-act="share-link" style="margin-top:10px">Share my link</button>` : ''}
    </div>`;
}

let wakeLock;
async function showFullQR() {
  const p = S.profile, url = normalizeLinkedIn(p.linkedin);
  if (!url) return renderBadge();
  const fs = document.createElement('div');
  fs.className = 'fs';
  fs.innerHTML = `<button data-act="qr-close">Done</button>${qrSVG(url)}<h2>${esc(p.name)}</h2><p>${esc([p.title, p.company].filter(Boolean).join(' · '))}</p>`;
  document.body.appendChild(fs);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* optional */ }
}
function closeFullQR() {
  $('.fs')?.remove();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function openProfileSheet() {
  const p = S.profile;
  openSheet(`
    <h3>Your badge</h3>
    <label class="field"><span>Name</span><input class="in" id="p-name" value="${esc(p.name)}"></label>
    <label class="field"><span>Title</span><input class="in" id="p-title" value="${esc(p.title)}"></label>
    <label class="field"><span>Company</span><input class="in" id="p-company" value="${esc(p.company)}"></label>
    <label class="field"><span>LinkedIn profile</span><input class="in" id="p-li" inputmode="url" autocapitalize="off" autocorrect="off" value="${esc(p.linkedin)}" placeholder="linkedin.com/in/you"></label>
    <button class="btn" data-act="profile-save" style="margin-top:6px">Save</button>`);
}

/* ----- debrief & reports ----- */
function stats() {
  const c = S.contacts;
  return {
    total: c.length, hot: c.filter((x) => x.tag === 'hot').length, warm: c.filter((x) => x.tag === 'warm').length,
    fyi: c.filter((x) => x.tag === 'fyi').length,
    sessions: S.plan.length, meetings: S.meetings.length,
    open: c.filter((x) => x.tag !== 'fyi' && !x.done).length,
  };
}

function renderDebrief() {
  const s = stats();
  const icon = (d) => `<div class="ic"><svg viewBox="0 0 24 24">${d}</svg></div>`;
  view().innerHTML = `
    <h1 class="title">Debrief</h1>
    <p class="sub">Three reports, built from what you captured.</p>
    <div class="stats">
      <div class="stat"><b>${s.total}</b><span>People</span></div>
      <div class="stat hot"><b>${s.hot}</b><span>Hot</span></div>
      <div class="stat warm"><b>${s.warm}</b><span>Warm</span></div>
      <div class="stat fyi"><b>${s.fyi}</b><span>FYI</span></div>
    </div>
    <div class="h2">Reports</div>
    <button class="report" data-act="open-report" data-v="summary">${icon('<path d="M5 20V10M12 20V4M19 20v-7"/>')}<div><b>Summary report</b><span>Themes, companies, headline numbers</span></div><i class="chev">›</i></button>
    <button class="report" data-act="open-report" data-v="followups">${icon('<path d="M4 12.5l5 5L20 6.5"/>')}<div><b>Follow-up contacts</b><span>${s.open} open · Hot and Warm, with next steps</span></div><i class="chev">›</i></button>
    <button class="report" data-act="open-report" data-v="lt">${icon('<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5M9 13h7M9 16.5h5"/>')}<div><b>LT debrief</b><span>Conversation by conversation, grouped by theme</span></div><i class="chev">›</i></button>
    <div class="h2">Your takeaways</div>
    <textarea class="ta" id="takeaways" placeholder="The three things you would tell the leadership team. They go at the top of the LT debrief.">${esc(S.takeaways)}</textarea>
    <div class="h2">Data</div>
    <div class="btn-row" style="margin-top:0">
      <button class="btn ghost sm" data-act="export-csv">Export CSV</button>
      <button class="btn ghost sm" data-act="backup">Back up all</button>
    </div>
    <label class="btn ghost sm" style="display:flex;align-items:center;justify-content:center;margin-top:10px">Restore from backup<input id="restore" type="file" accept="application/json,.json" hidden></label>`;
}

const bullet = (c) => {
  const bits = [`**${c.name}**${c.company ? ` (${c.company})` : ''}`];
  const body = c.notes ? ` — ${c.notes.replace(/\s*\n+\s*/g, ' ')}` : '';
  const next = c.nextStep ? ` _Next: ${c.nextStep}_` : '';
  return `- ${bits[0]} [${TAG_LABEL[c.tag]}]${body}${next}`;
};

function buildReport(kind) {
  const s = stats(), cs = [...S.contacts].sort((a, b) => a.createdAt - b.createdAt);
  const head = (t) => `# ${t}\n${EVENT_NAME}, Salt Lake City, Nov 9–12, 2026\n`;
  const byTheme = {};
  cs.forEach((c) => (c.themes.length ? c.themes : ['Other']).forEach((t) => (byTheme[t] = byTheme[t] || []).push(c)));
  const themeOrder = Object.keys(byTheme).sort((a, b) => byTheme[b].length - byTheme[a].length);
  const hotWarm = cs.filter((c) => c.tag !== 'fyi');

  if (kind === 'summary') {
    const companies = [...new Set(cs.map((c) => c.company).filter(Boolean))];
    return [
      head('Summary report'),
      `## Headlines`,
      `- ${s.total} conversations: ${s.hot} hot, ${s.warm} warm, ${s.fyi} FYI`,
      `- ${s.open} follow-ups open`,
      `- ${s.sessions} sessions in my plan, ${s.meetings} scheduled meetings`,
      companies.length ? `- ${companies.length} companies: ${companies.join(', ')}` : '',
      '',
      `## Themes`,
      ...(themeOrder.length ? themeOrder.map((t) => `- ${t}: ${byTheme[t].length} (${byTheme[t].map((c) => c.name).join(', ')})`) : ['- No themes tagged yet']),
      '',
      `## Hot leads`,
      ...(cs.filter((c) => c.tag === 'hot').map(bullet).concat(s.hot ? [] : ['- None marked hot'])),
    ].filter((l) => l !== undefined).join('\n');
  }

  if (kind === 'followups') {
    const row = (c) => `- [${c.done ? 'x' : ' '}] **${c.name}**${c.company ? `, ${c.company}` : ''}${c.contact ? ` · ${c.contact}` : ' · no contact details yet'}\n  - Next: ${c.nextStep || 'Decide the next step'}`;
    return [
      head('Follow-up contacts'),
      `## Hot (${s.hot})`, ...(cs.filter((c) => c.tag === 'hot').map(row).concat(s.hot ? [] : ['- None'])), '',
      `## Warm (${s.warm})`, ...(cs.filter((c) => c.tag === 'warm').map(row).concat(s.warm ? [] : ['- None'])),
    ].join('\n');
  }

  // LT debrief
  const planByDay = DAY_ORDER.map((d) => {
    const ids = S.plan.map(itemById).filter((i) => i && i.day === d).sort((a, b) => toMin(a.start) - toMin(b.start));
    return ids.length ? `- ${dayParts(d).wd}: ${ids.map((i) => i.title).join('; ')}` : '';
  }).filter(Boolean);
  const photos = cs.filter((c) => c.photoId).length;
  return [
    head('Leadership team debrief'),
    `## My takeaways`,
    S.takeaways.trim() || '_Add your top takeaways in the Debrief tab._',
    '',
    `## By the numbers`,
    `- ${s.total} conversations (${s.hot} hot, ${s.warm} warm, ${s.fyi} FYI), ${s.open} follow-ups open`,
    `- ${s.sessions} sessions attended or planned${photos ? `, ${photos} photos on my phone` : ''}`,
    '',
    `## What I heard, by theme`,
    ...(themeOrder.length ? themeOrder.flatMap((t) => [`### ${t} (${byTheme[t].length})`, ...byTheme[t].map(bullet), '']) : ['_No conversations captured yet._', '']),
    `## Follow-ups`,
    ...(hotWarm.length ? hotWarm.map((c) => `- ${c.done ? '[x]' : '[ ]'} ${c.name}${c.company ? ` (${c.company})` : ''}: ${c.nextStep || 'next step to be decided'}`) : ['- None']),
    '',
    `## Sessions I planned`,
    ...(planByDay.length ? planByDay : ['- None starred']),
  ].join('\n');
}

const REPORT_TITLES = { summary: 'Summary report', followups: 'Follow-up contacts', lt: 'LT debrief' };

function openReport(kind) {
  const md = buildReport(kind);
  openSheet(`
    <h3>${REPORT_TITLES[kind]}</h3>
    <p class="sub" style="margin:0 0 12px">Markdown. Paste it into Slack, Confluence or an email.</p>
    <div class="md" id="report-md">${esc(md)}</div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn sm" data-act="report-copy" data-v="${kind}">Copy</button>
      <button class="btn ghost sm" data-act="report-share" data-v="${kind}">Share</button>
    </div>`);
}

/* ---------- export helpers ---------- */
async function shareOrDownload(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function buildCSV() {
  const head = ['Name', 'Company', 'Heat', 'Contact', 'Themes', 'Notes', 'Next step', 'Follow-up done', 'Captured'];
  const rows = S.contacts.map((c) => [c.name, c.company, TAG_LABEL[c.tag], c.contact, c.themes.join('; '), c.notes, c.nextStep, c.done ? 'yes' : 'no', new Date(c.createdAt).toISOString()]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function buildVCard(c) {
  const parts = c.name.trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : '';
  const first = parts.join(' ');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${last};${first};;;`, `FN:${c.name}`];
  if (c.company) lines.push(`ORG:${c.company}`);
  const ct = c.contact || '';
  const email = ct.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  const tel = !email && ct.match(/\+?[\d][\d\s().-]{6,}/);
  const li = /linkedin\.com/i.test(ct) ? ct.match(/\S*linkedin\.com\S*/i)[0] : '';
  if (email) lines.push(`EMAIL:${email[0]}`);
  if (tel) lines.push(`TEL:${tel[0].trim()}`);
  if (li) lines.push(`URL:${/^https?:/i.test(li) ? li : 'https://' + li}`);
  lines.push(`NOTE:Met at ${EVENT_NAME}. ${c.notes.replace(/\n/g, ' ')}`.slice(0, 400));
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

async function backupAll() {
  const toDataURL = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  const photos = {};
  for (const c of S.contacts) if (c.photoId) { const b = await photoGet(c.photoId); if (b) photos[c.photoId] = await toDataURL(b); }
  const data = { v: 1, at: new Date().toISOString(), profile: S.profile, plan: S.plan, meetings: S.meetings, contacts: S.contacts, takeaways: S.takeaways, photos };
  await shareOrDownload(`kubecon-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}

async function restoreFrom(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.v !== 1 || !Array.isArray(data.contacts)) throw new Error('bad');
    for (const [id, url] of Object.entries(data.photos || {})) await photoPut(id, await (await fetch(url)).blob());
    Object.assign(S, { profile: data.profile, plan: data.plan || [], meetings: data.meetings || [], contacts: data.contacts, takeaways: data.takeaways || '' });
    await Promise.all(['profile', 'plan', 'meetings', 'contacts', 'takeaways'].map(persist));
    toast(`Restored ${S.contacts.length} conversations`);
    render();
  } catch (e) {
    toast('That file is not a KubeCon backup.');
  }
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) return setTab(tabBtn.dataset.tab);

  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id, v = t.dataset.v;

  switch (act) {
    case 'close-sheet': return closeSheet();
    case 'toast-action': $('#toast').classList.remove('show'); return $('#toast')._action?.();

    case 'welcome-save': {
      const name = $('#w-name').value.trim();
      if (!name) { toast('Add your name to continue.'); return $('#w-name').focus(); }
      S.profile = { name, title: $('#w-title').value.trim(), company: $('#w-company').value.trim(), linkedin: $('#w-li').value.trim() };
      await persist('profile');
      return setTab(S.profile.linkedin ? 'schedule' : 'badge');
    }

    case 'pick-day': S.ui.day = t.dataset.day; { const y = view().scrollTop; renderSchedule(); view().scrollTop = Math.min(y, 120); } return;
    case 'plan-only': S.ui.planOnly = v === '1'; return renderSchedule();
    case 'pick-track': S.ui.track = t.dataset.track; return renderSchedule();
    case 'add-meeting': return openMeetingSheet();
    case 'save-meeting': {
      const title = $('#m-title').value.trim();
      const start = $('#m-start').value, end = $('#m-end').value;
      if (!title) return toast('Give the meeting a name.');
      if (!start || !end || toMin(end) <= toMin(start)) return toast('The end time must be after the start.');
      S.meetings.push({ id: 'm' + uid(), day: $('#m-day').value, start, end, title, room: $('#m-room').value.trim(), withWho: $('#m-with').value.trim() });
      await persist('meetings');
      S.ui.day = $('#m-day').value;
      closeSheet(); renderSchedule(); return toast('Meeting added');
    }
    case 'delete-meeting':
      S.meetings = S.meetings.filter((m) => m.id !== id);
      await persist('meetings'); closeSheet(); return renderSchedule();

    case 'open-item': if (!e.target.closest('.s-star')) openItemSheet(id); return;
    case 'toggle-plan': {
      e.stopPropagation();
      S.plan = isPlanned(id) ? S.plan.filter((x) => x !== id) : [...S.plan, id];
      await persist('plan');
      if (t.dataset.close) closeSheet();
      const y = view().scrollTop;
      if (S.ui.tab === 'schedule') { renderSchedule(); view().scrollTop = y; }
      return;
    }
    case 'capture-here':
      closeSheet(); S.draft = S.draft || blankDraft(); S.draft.sessionId = id; S.draft.sessionAuto = false; return setTab('capture');

    // capture
    case 'draft-tag': readDraftInputs(); S.draft.tag = v; return renderCapture();
    case 'draft-theme': {
      readDraftInputs();
      const th = S.draft.themes; const i = th.indexOf(v);
      i < 0 ? th.push(v) : th.splice(i, 1);
      const y = view().scrollTop; renderCapture(); view().scrollTop = y; return;
    }
    case 'draft-photo-clear': readDraftInputs(); S.draft.photoId = ''; return renderCapture();
    case 'draft-ctx-clear': readDraftInputs(); S.draft.sessionId = ''; S.draft.sessionAuto = false; return renderCapture();
    case 'save-contact': return saveContact();

    // people
    case 'pick-pfilter': S.ui.pfilter = v; return renderPeople();
    case 'open-contact': return openContactSheet(id);
    case 'contact-tag': {
      const c = contactFromSheet(id); if (!c) return;
      c.tag = v; await persist('contacts'); openContactSheet(id); return render();
    }
    case 'contact-theme': {
      const c = contactFromSheet(id); if (!c) return;
      const i = c.themes.indexOf(v); i < 0 ? c.themes.push(v) : c.themes.splice(i, 1);
      await persist('contacts'); return openContactSheet(id);
    }
    case 'contact-done': {
      const c = contactFromSheet(id); if (!c) return;
      c.done = !c.done; await persist('contacts'); closeSheet(); return render();
    }
    case 'contact-save': {
      const c = contactFromSheet(id); if (!c) return;
      await persist('contacts'); closeSheet(); render(); return toast('Saved');
    }
    case 'contact-vcard': {
      const c = contactFromSheet(id); if (!c) return;
      return shareOrDownload(`${c.name.replace(/\W+/g, '-')}.vcf`, buildVCard(c), 'text/vcard');
    }
    case 'contact-delete': {
      const c = S.contacts.find((x) => x.id === id); if (!c) return;
      S.contacts = S.contacts.filter((x) => x.id !== id);
      await persist('contacts'); closeSheet(); render();
      return toast(`Deleted ${c.name}`, { label: 'Undo', fn: async () => { S.contacts.push(c); S.contacts.sort((a, b) => b.createdAt - a.createdAt); await persist('contacts'); render(); } });
    }

    // badge
    case 'qr-full': return showFullQR();
    case 'qr-close': return closeFullQR();
    case 'edit-profile': return openProfileSheet();
    case 'profile-save': {
      const name = $('#p-name').value.trim();
      if (!name) return toast('Your name cannot be empty.');
      S.profile = { name, title: $('#p-title').value.trim(), company: $('#p-company').value.trim(), linkedin: $('#p-li').value.trim() };
      await persist('profile'); closeSheet(); return renderBadge();
    }
    case 'share-link': {
      const url = normalizeLinkedIn(S.profile.linkedin);
      try { await navigator.share({ title: S.profile.name, url }); } catch (err) { if (err.name !== 'AbortError') { await navigator.clipboard?.writeText(url); toast('Link copied'); } }
      return;
    }

    // debrief
    case 'open-report': return openReport(v);
    case 'report-copy':
      try { await navigator.clipboard.writeText(buildReport(v)); toast('Copied'); } catch (err) { toast('Copy failed. Use Share instead.'); }
      return;
    case 'report-share': return shareOrDownload(`kubecon-${v}.md`, buildReport(v), 'text/markdown');
    case 'export-csv': return shareOrDownload('kubecon-people.csv', buildCSV(), 'text/csv');
    case 'backup': return backupAll();
  }
});

document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'sq') { S.ui.q = e.target.value; paintScheduleList(); }
  else if (id === 'pq') { S.ui.pq = e.target.value; paintPeople(); }
  else if (id === 'takeaways') { S.takeaways = e.target.value; clearTimeout(S._tk); S._tk = setTimeout(() => persist('takeaways'), 400); }
  else if (S.draft && /^c-(name|company|notes|contact|next)$/.test(id)) readDraftInputs();
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'c-photo') {
    readDraftInputs();
    const id = await handlePhotoFile(e.target.files[0]);
    if (id) { S.draft.photoId = id; renderCapture(); }
  } else if (e.target.id === 'restore') {
    restoreFrom(e.target.files[0]);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.s-card')) { e.preventDefault(); openItemSheet(e.target.dataset.id); }
});

/* ---------- boot ---------- */
async function boot() {
  try {
    const res = await fetch('sessions.json');
    S.sessions = await res.json();
    S.byId = new Map(S.sessions.map((s) => [s.id, s]));
  } catch (e) {
    view().innerHTML = `<div class="empty"><b>Schedule not loaded</b>Connect to the internet once, then reopen the app.</div>`;
  }
  try {
    const [profile, plan, meetings, contacts, takeaways] = await Promise.all(['profile', 'plan', 'meetings', 'contacts', 'takeaways'].map(kvGet));
    if (profile) S.profile = profile;
    S.plan = plan || []; S.meetings = meetings || []; S.contacts = contacts || []; S.takeaways = takeaways || '';
  } catch (e) {
    toast('Storage is unavailable in this browser mode.');
  }
  navigator.storage?.persist?.();
  await Promise.all(S.contacts.filter((c) => c.photoId).map((c) => photoURL(c.photoId)));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.ui.tab));
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
