// ─── STATE ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "rehab-tracker-v3";
let S = {
  phase: 0, session: 0, view: "today",
  expanded: null, logs: {},
  logEx: null, logPain: 0, logDiff: 0,
  p2BonusSeed: Date.now()
};

const todayKey = () => new Date().toISOString().split("T")[0];
const logKey   = id => `${todayKey()}__${id}`;
const loadLogs = () => { try { const d = localStorage.getItem(STORAGE_KEY); if (d) S.logs = JSON.parse(d); } catch(e){} };
const saveLogs = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(S.logs));

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Find exercise object across all phases and bonus pools
function findEx(id) {
  for (const p of PHASES) for (const s of p.sessions) for (const e of s.exercises) if (e.id === id) return { ex: e, phase: p };
  for (const p of PHASES) if (p.bonusPool) for (const e of p.bonusPool) if (e.id === id) return { ex: e, phase: p };
  return null;
}

// Seeded shuffle — picks N items reproducibly given a numeric seed (mulberry32)
function seededPick(arr, n, seed) {
  let s = seed >>> 0;
  function rand() { s += 0x6D2B79F5; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  const pool = [...arr];
  const out  = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(rand() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// Get the 3 randomly-selected exercises for today's Phase 2 session
function getP2Session() {
  const ph = PHASES.find(p => p.id === 2);
  if (!ph || !ph.bonusPool) return [];
  return seededPick(ph.bonusPool, 3, S.p2BonusSeed);
}

function shuffleP2() {
  S.p2BonusSeed = Date.now() + Math.floor(Math.random() * 99999);
  S.expanded = null;
  renderExercises();
  renderProgress();
}

// ─── PHASE COLOR HELPER ───────────────────────────────────────────────────────
function colorVars(c) {
  document.documentElement.style.setProperty('--pc', c);
}

// ─── VIDEO HELPERS ────────────────────────────────────────────────────────────
function ytSearchURL(q) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

// Build the expandable panel content: DB photos + instructions + video button
function thumbHTML(exId, phaseColor, exName) {
  const dbEntry = dbLookup(exName);
  let illusHtml = '';
  let instrHtml = '';

  if (dbEntry && dbEntry.images && dbEntry.images.length >= 2) {
    const labels = ['Start', 'End'];
    const imgTags = dbEntry.images.slice(0, 2).map((url, i) => `
      <div style="flex:1;min-width:0;text-align:center;">
        <div style="font-size:10px;color:#7dd3c8;font-weight:700;letter-spacing:1px;margin-bottom:4px;text-transform:uppercase;">${labels[i]}</div>
        <img src="${url}"
          onerror="this.parentElement.style.display='none'"
          alt="${labels[i]}"
          style="width:100%;border-radius:8px;display:block;object-fit:cover;max-height:160px;background:#1e293b;" />
      </div>`).join('');
    illusHtml = `<div style="display:flex;gap:8px;margin-bottom:10px;padding:10px;background:#0f172a;border-radius:12px;border:1px solid #1e293b;">${imgTags}</div>`;
  }

  if (dbEntry && dbEntry.instructions && dbEntry.instructions.length) {
    const steps = dbEntry.instructions.map(step =>
      `<li style="margin-bottom:6px;color:#aaa;font-size:13px;line-height:1.5;">${step}</li>`
    ).join('');
    instrHtml = `
      <div style="margin-bottom:12px;padding:12px;background:#0a0a18;border-radius:10px;border:1px solid #1a1a2e;">
        <div style="font-size:10px;color:#7dd3c8;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">📋 Step-by-Step</div>
        <ol style="margin:0;padding-left:18px;">${steps}</ol>
      </div>`;
  }

  const v   = VIDEOS[exId];
  const tid = THUMB_IDS[exId];
  if (!v) return illusHtml + instrHtml;
  if (!tid) {
    const searchURL = ytSearchURL(v.q);
    return `<div class="vid-thumb-wrap">${illusHtml}${instrHtml}
      <a class="vid-fallback" href="${searchURL}" target="_blank" rel="noopener">
        🔍 Search "${v.label}" on YouTube
      </a>
    </div>`;
  }
  return `
    <div class="vid-thumb-wrap" data-ex="${exId}" data-color="${phaseColor}">
      ${illusHtml}${instrHtml}
      <button class="vid-watch-btn" onclick="playVideo('${exId}','${phaseColor}')"
        style="display:flex;align-items:center;gap:10px;width:100%;padding:14px 18px;
               border-radius:12px;border:none;cursor:pointer;
               background:#1a1a2e;color:#fff;font-size:15px;font-weight:600;
               box-shadow:0 2px 12px rgba(0,0,0,0.3);">
        <span style="display:inline-flex;align-items:center;justify-content:center;
                     width:38px;height:38px;border-radius:50%;flex-shrink:0;
                     background:${phaseColor};box-shadow:0 2px 8px ${phaseColor}88;font-size:16px;">▶</span>
        <span>Watch Demo</span>
      </button>
    </div>`;
}

// Open video on YouTube (embedding blocked in local/app contexts)
function playVideo(exId, phaseColor) {
  const v   = VIDEOS[exId];
  const tid = THUMB_IDS[exId];
  if (!v) return;
  const url = tid
    ? `https://www.youtube.com/watch?v=${tid}`
    : ytSearchURL(v.q);
  window.open(url, '_blank', 'noopener');
}

function quickPlay(exId, phaseColor) {
  playVideo(exId, phaseColor);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function applyPhaseTheme() {
  const p = PHASES[S.phase];
  colorVars(p.color);
  const badge = document.getElementById('phase-badge');
  badge.style.cssText = `background:${p.color}22;border:1px solid ${p.color}44;border-radius:10px;padding:6px 12px;text-align:center;`;
  document.getElementById('badge-sub').style.color  = p.color;
  document.getElementById('badge-name').style.color = p.color;
  document.getElementById('badge-name').textContent = p.name;
  document.querySelectorAll('.nav-tab').forEach(t => {
    const active = t.dataset.view === S.view;
    t.style.borderBottomColor = active ? p.color : 'transparent';
    t.style.color = active ? p.color : '#555';
  });
}

function renderPhasePills() {
  document.getElementById('phase-selector').innerHTML = PHASES.map((p, i) =>
    `<button class="phase-btn" onclick="selectPhase(${i})"
      style="${i===S.phase ? `background:${p.color};border-color:${p.color};color:#fff;` : ''}"
    >${p.name}</button>`
  ).join('');
}

function renderSessionTabs() {
  const p  = PHASES[S.phase];
  const el = document.getElementById('session-tabs');
  if (p.sessions.length <= 1) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.innerHTML = p.sessions.map((s, i) =>
    `<button class="session-tab ${i===S.session?'active':''}"
      style="${i===S.session ? `border-color:${p.color}66;` : ''}"
      onclick="selectSession(${i})">${s.emoji} ${s.name}</button>`
  ).join('');
}

function renderProgress() {
  const p    = PHASES[S.phase];
  const sess = p.sessions[S.session];
  const allEx = (p.id === 2) ? getP2Session() : sess.exercises;
  const done = allEx.filter(e => !!S.logs[logKey(e.id)]).length;
  const tot  = allEx.length;
  const pct  = tot ? Math.round(done / tot * 100) : 0;
  document.getElementById('prog-label').textContent = `${sess.emoji} ${sess.name}`;
  const cnt = document.getElementById('prog-count');
  cnt.textContent = `${done}/${tot} done`;
  cnt.style.color = p.color;
  const fill = document.getElementById('prog-fill');
  fill.style.width      = `${pct}%`;
  fill.style.background = `linear-gradient(90deg, ${p.color}, ${p.color}BB)`;
}

function renderExercises() {
  const p    = PHASES[S.phase];
  const sess = p.sessions[S.session];

  function exCardHTML(ex) {
    const log     = S.logs[logKey(ex.id)];
    const checked = !!log;
    const open    = S.expanded === ex.id;
    const hasV    = !!VIDEOS[ex.id];
    const painCol = log && log.pain > 0
      ? (log.pain <= 3 ? '#4A9B8E' : log.pain <= 6 ? '#E8A838' : '#C94F4F') : '';

    const chips = log && (log.sets || log.pain > 0) ? `
      <div class="log-chips">
        ${log.sets   ? `<span class="log-chip">${log.sets} × ${log.reps}</span>` : ''}
        ${log.pain > 0 ? `<span class="log-chip" style="color:${painCol}">Pain: ${log.pain}/10</span>` : ''}
        ${log.difficulty > 0 ? `<span class="log-chip">Effort: ${['','Easy','Light','Mod','Hard','Max'][log.difficulty]}</span>` : ''}
      </div>` : '';

    return `
      <div class="ex-card" style="${checked ? `border-color:${p.color}44;background:${p.color}18;` : ''}">
        <div class="ex-row">
          <button class="ex-check" onclick="toggleCheck('${ex.id}')"
            style="${checked ? `border-color:${p.color};background:${p.color};color:#fff;` : ''}">
            ${checked ? '✓' : ''}
          </button>
          <div class="ex-info">
            <div class="ex-name" style="${checked ? 'color:#fff;' : ''}">${ex.name}</div>
            <div class="ex-meta">${ex.sets} sets · ${ex.reps}</div>
          </div>
          <div class="ex-btns">
            <button class="ex-btn" onclick="toggleExpand('${ex.id}')"
              style="${open ? `border-color:${p.color}66;background:${p.color}22;color:${p.color};` : ''}">
              ${open ? '▲' : '▼'}
            </button>
            ${hasV ? `
            <button class="ex-btn" title="Watch video"
              onclick="quickPlay('${ex.id}','${p.color}')"
              style="border-color:${p.color}44;background:${p.color}22;color:${p.color};font-weight:700;">
              ▶
            </button>` : ''}
            <button class="ex-btn" onclick="openLog('${ex.id}')"
              style="${log && log.sets ? `border-color:${p.color}44;background:${p.color}22;color:${p.color};` : ''}">
              📊
            </button>
          </div>
        </div>
        <div class="ex-panel ${open ? 'open' : ''}">
          <div class="ex-tip" style="border-left-color:${p.color};">💡 ${ex.tip}</div>
          ${thumbHTML(ex.id, p.color, ex.name)}
        </div>
        ${chips}
      </div>`;
  }

  const exercises = (p.id === 2) ? getP2Session() : sess.exercises;
  const listHTML  = exercises.map(ex => exCardHTML(ex)).join('');

  const shuffleBar = (p.id === 2) ? `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <div style="font-size:11px;color:#666;letter-spacing:1px;text-transform:uppercase;flex:1;">
        🎲 Daily draw · 3 of ${p.bonusPool.length} exercises
      </div>
      <button onclick="shuffleP2()" style="font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid #2A2A3A;background:#1A1A2E;color:${p.color};cursor:pointer;font-family:inherit;font-weight:600;">
        ↺ Shuffle
      </button>
    </div>` : '';

  document.getElementById('exercise-list').innerHTML = shuffleBar + listHTML;
}

function renderPhasesView() {
  document.getElementById('phases-list').innerHTML = PHASES.map((p, i) => {
    const total = p.sessions.reduce((a, s) => a + s.exercises.length, 0);
    return `
      <button class="phase-card" onclick="selectPhaseAndGo(${i})"
        style="border-color:${i===S.phase ? p.color+'66' : '#1E1E30'};">
        <div class="phase-icon" style="background:${p.color}22;border:1px solid ${p.color}44;">${p.emoji}</div>
        <div class="phase-card-body">
          <div class="phase-card-top">
            <span class="phase-card-name">${p.name}</span>
            <span class="phase-weeks" style="color:${p.color};background:${p.color}22;">${p.weeks}</span>
          </div>
          <div class="phase-card-sub">${p.subtitle}</div>
          <div class="phase-card-count">${total} exercises · ${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''}</div>
        </div>
        <span style="color:#333;font-size:18px;">›</span>
      </button>`;
  }).join('');
}

function renderHistory() {
  const p     = PHASES[S.phase];
  const today = todayKey();

  // Calendar strip — last 14 days
  const days = Array.from({length:14}, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (13 - i));
    const k = d.toISOString().split("T")[0];
    const n = Object.keys(S.logs).filter(l => l.startsWith(k + '__')).length;
    return { k, d, n };
  });
  document.getElementById('cal-strip').innerHTML = days.map(({k, d, n}) => {
    const isToday = k === today;
    return `<div class="cal-day"
      style="${n > 0 ? `background:${p.color}33;` : ''}border-color:${isToday ? p.color : n > 0 ? p.color+'44' : '#1E1E30'};">
      <div class="cal-weekday">${d.toLocaleDateString('en',{weekday:'narrow'})}</div>
      <div class="cal-num" style="color:${isToday ? p.color : n > 0 ? '#fff' : '#444'};">${d.getDate()}</div>
      <div class="cal-count" style="color:${p.color};">${n > 0 ? n : '·'}</div>
    </div>`;
  }).join('');

  // Recent session list
  const entries = Object.entries(S.logs)
    .sort((a, b) => (b[1].ts||0) - (a[1].ts||0))
    .slice(0, 20)
    .map(([k, log]) => {
      const [dateStr, exId] = k.split('__');
      const found = findEx(exId);
      if (!found) return null;
      const { ex, phase: ph } = found;
      const painCol   = log.pain > 0 ? (log.pain<=3?'#4A9B8E':log.pain<=6?'#E8A838':'#C94F4F') : '';
      const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en', {month:'short', day:'numeric'});
      return `
        <div class="history-item">
          <div class="history-dot" style="background:${ph.color};"></div>
          <div style="flex:1;min-width:0;">
            <div class="history-name">${ex.name}</div>
            <div class="history-meta">${dateLabel}${log.sets ? ` · ${log.sets}×${log.reps}` : ''}${log.pain > 0 ? ` · Pain ${log.pain}/10` : ''}</div>
          </div>
          ${log.pain > 0 ? `<span style="font-size:12px;font-weight:700;color:${painCol};flex-shrink:0;">${log.pain}/10</span>` : ''}
        </div>`;
    }).filter(Boolean);

  document.getElementById('history-list').innerHTML = entries.length
    ? entries.join('')
    : `<div class="empty-state">No sessions logged yet.<br><span style="color:#555;">Start checking off exercises on Today.</span></div>`;
}

function renderAll() {
  applyPhaseTheme();
  renderPhasePills();
  renderSessionTabs();
  renderProgress();
  renderExercises();
  renderPhasesView();
  renderHistory();
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${S.view}`).classList.add('active');
  applyPhaseTheme(); // re-apply after nav tabs re-render
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
function selectPhase(i)      { S.phase = i; S.session = 0; S.expanded = null; renderAll(); }
function selectPhaseAndGo(i) { S.phase = i; S.session = 0; S.expanded = null; S.view = 'today'; renderAll(); }
function selectSession(i)    { S.session = i; S.expanded = null; renderProgress(); renderExercises(); }
function toggleExpand(id)    { S.expanded = S.expanded === id ? null : id; renderExercises(); }

function toggleCheck(id) {
  const k = logKey(id);
  if (S.logs[k]) delete S.logs[k];
  else S.logs[k] = { done: true, ts: Date.now() };
  saveLogs();
  renderProgress();
  renderExercises();
}

// ─── VIDEO MODAL ──────────────────────────────────────────────────────────────
function closeVideo() {
  document.getElementById('vid-modal').classList.remove('open');
  document.getElementById('vid-frame').innerHTML = '';
}
document.getElementById('vid-close').onclick = closeVideo;
document.getElementById('vid-modal').onclick  = e => { if (e.target === document.getElementById('vid-modal')) closeVideo(); };

// ─── LOG MODAL ────────────────────────────────────────────────────────────────
function openLog(exId) {
  const found = findEx(exId);
  if (!found) return;
  const { ex, phase: ph } = found;
  const log = S.logs[logKey(exId)] || {};
  S.logEx = ex; S.logPain = log.pain || 0; S.logDiff = log.difficulty || 0;

  document.getElementById('log-title').textContent = ex.name;
  document.getElementById('log-sub').textContent   = `Target: ${ex.sets} sets · ${ex.reps}`;
  document.getElementById('log-sets').value        = log.sets || '';
  document.getElementById('log-sets').placeholder  = ex.sets;
  document.getElementById('log-reps').value        = log.reps || '';
  document.getElementById('log-reps').placeholder  = ex.reps;
  document.getElementById('log-notes').value       = log.notes || '';
  document.getElementById('save-btn').style.background = ph.color;

  renderPainDots(ph.color);
  renderDiffBtns(ph.color);
  document.getElementById('log-modal').classList.add('open');
}

function renderPainDots(phColor) {
  document.getElementById('pain-dots').innerHTML = Array.from({length:11}, (_, n) => {
    const on  = n <= S.logPain;
    const col = on ? (n<=3?'#4A9B8E':n<=6?'#E8A838':'#C94F4F') : '#2A2A3A';
    return `<button class="pain-dot" onclick="setPain(${n})"
      style="background:${col};color:${on?'#fff':'#555'};${n===S.logPain?'transform:scale(1.2);':''}">${n}</button>`;
  }).join('');
}

function renderDiffBtns(phColor) {
  const ph = PHASES[S.phase];
  document.getElementById('diff-row').innerHTML =
    ['Easy','Light','Mod','Hard','Max'].map((label, i) => {
      const n  = i + 1;
      const on = n <= S.logDiff;
      return `<button class="diff-btn" onclick="setDiff(${n})"
        style="${on ? `background:${ph.color};color:#fff;` : ''}">${label}</button>`;
    }).join('');
}

function setPain(n) { S.logPain = n; renderPainDots(); }
function setDiff(n) { S.logDiff = n; renderDiffBtns(); }

function closeLog() { document.getElementById('log-modal').classList.remove('open'); S.logEx = null; }
document.getElementById('log-close').onclick      = closeLog;
document.getElementById('log-modal').onclick      = e => { if (e.target === document.getElementById('log-modal')) closeLog(); };
document.getElementById('log-modal-inner').onclick = e => e.stopPropagation();

document.getElementById('save-btn').onclick = () => {
  if (!S.logEx) return;
  S.logs[logKey(S.logEx.id)] = {
    done: true, ts: Date.now(),
    sets: document.getElementById('log-sets').value,
    reps: document.getElementById('log-reps').value,
    pain: S.logPain, difficulty: S.logDiff,
    notes: document.getElementById('log-notes').value,
  };
  saveLogs();
  closeLog();
  renderProgress(); renderExercises(); renderHistory();
  showToast();
};

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast() {
  const t = document.getElementById('toast');
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1700);
}

// ─── NAV ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.onclick = () => { S.view = tab.dataset.view; renderAll(); };
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
loadLogs();
renderAll();
loadExerciseDB(); // async — re-renders exercises when complete
