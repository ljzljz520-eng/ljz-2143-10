// C 窗口逻辑：轮询看板 / 离线缓存 / 身份验证 / 确认（绑定修订+班次+人员）
const $ = id => document.getElementById(id);
const state = {
  token: null,
  person: null,
  board: null,
  serverOffset: 0,        // 服务端时间 - 本地时间（ms）
  online: navigator.onLine,
  lastOkAt: null,         // 最后成功同步时间
  pendingAck: null,       // 待确认的卡片条目
};
const LS_CACHE = 'safety-board-cache';

// ---------- 时钟 ----------
function tick() {
  const d = new Date(Date.now() + state.serverOffset);
  $('clock').textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
  $('clockSub').textContent = d.toLocaleDateString('zh-CN') +
    (Math.abs(state.serverOffset) > 60000 ? '（已按服务器校时）' : '');
}
setInterval(tick, 1000); tick();

async function syncTime() {
  const t0 = Date.now();
  const r = await fetch('/api/time', { cache: 'no-store' });
  const t1 = Date.now();
  const j = await r.json();
  state.serverOffset = j.server_ts - (t0 + t1) / 2;
}

// ---------- 网络状态 ----------
function setOnline(on) {
  state.online = on;
  $('offlineBanner').classList.toggle('hidden', on);
  if (!on) $('cachedAt').textContent = state.lastOkAt
    ? new Date(state.lastOkAt).toLocaleString('zh-CN') : '（本次启动后尚无成功同步）';
}
window.addEventListener('online', () => { setOnline(true); refresh(); });
window.addEventListener('offline', () => setOnline(false));

// ---------- 看板 ----------
async function refresh() {
  if (!navigator.onLine) { setOnline(false); renderFromCache(); return; }
  try {
    await syncTime();
    const r = await fetch('/api/board', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const board = await r.json();
    state.board = board;
    state.lastOkAt = Date.now() + state.serverOffset;
    localStorage.setItem(LS_CACHE, JSON.stringify({ board, at: state.lastOkAt }));
    setOnline(true);
    render(board);
  } catch (e) {
    setOnline(false);
    renderFromCache();
  }
}
function renderFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
    if (c) { state.board = c.board; state.lastOkAt = c.at; render(c.board, true); }
  } catch (_) {}
}

const SRC_LABEL = { frozen: '整班冻结', supplement: '班中增补', revision: '班中换版' };
const STATUS_LABEL = { active: '', superseded: '已被新版取代', withdrawn: '已撤回' };
const PSTATUS_LABEL = {
  pending: '待确认', confirmed: '已确认', confirmed_late: '迟到回执',
  superseded: '旧版已失效', withdrawn: '已撤回', carried: '待补确认(结转)',
};

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function render(board, fromCache) {
  if (!board.shift) {
    $('shiftName').textContent = '当前无进行中的班次';
    $('cardGrid').innerHTML = '<div class="empty">暂无开班。请管理员在 Web 端开班（冻结清单）后，此处自动显示。</div>';
    [['sumFrozen',0],['sumSupplement',0],['sumRevision',0],['sumDone','0/0'],['sumCarried',0]]
      .forEach(([k,v]) => $(k).textContent = v);
    $('memberChips').innerHTML = '';
    return;
  }
  const s = board.shift;
  $('shiftName').textContent =
    `${esc(s.name)}（${s.status === 'active' ? '进行中' : '已交班'}）` +
    `${s.planned_start ? ' · ' + esc(s.planned_start) + '–' + esc(s.planned_end) : ''}` +
    (fromCache ? ' · 缓存数据' : '');

  const ls = board.lists_summary;
  $('sumFrozen').textContent = ls.frozen;
  $('sumSupplement').textContent = ls.supplement;
  $('sumRevision').textContent = ls.revision;
  $('sumCarried').textContent = ls.carried;
  let done = 0, total = 0;
  board.cards.filter(c => c.status === 'active').forEach(c => { done += c.progress.done; total += c.progress.total; });
  $('sumDone').textContent = `${done}/${total}`;
  $('memberChips').innerHTML = board.members.map(m =>
    `<span class="chip">${esc(m.name)}${m.role ? ' · ' + esc(m.role) : ''}</span>`).join('');

  $('cardGrid').innerHTML = board.cards.map(c => cardHtml(c)).join('') ||
    '<div class="empty">本班暂无卡片。</div>';

  board.cards.forEach(c => {
    const btn = $('ack-' + c.shift_card_id);
    if (btn) btn.addEventListener('click', () => openAck(c));
    const im = $('img-' + c.shift_card_id);
    if (im) im.addEventListener('error', () => im.closest('.card-media').classList.add('no-img'));
  });
}

function cardHtml(c) {
  const mine = c.confirmations.find(x => x.person_id === state.person?.id);
  const canAck = c.status === 'active' &&
    (mine?.status === 'pending' || mine?.status === 'carried');
  const cls = ['card'];
  if (c.source === 'supplement') cls.push('sup');
  if (c.source === 'revision' && c.status === 'active') cls.push('rev');
  if (c.status !== 'active') cls.push(c.status);
  const pct = c.progress.total ? Math.round(c.progress.done / c.progress.total * 100) : 0;
  return `<div class="${cls.join(' ')}">
    <div class="card-media ${c.image_url ? '' : 'no-img'}">
      ${c.image_url ? `<img id="img-${c.shift_card_id}" src="${esc(c.image_url)}" alt="${esc(c.title)}配图">` : ''}
      <div class="img-placeholder">⚠ 配图不可用<br><small>（图片解码失败/缺失，以下文字内容完整保留）</small></div>
      <span class="badge ${c.source}">${SRC_LABEL[c.source]}</span>
      ${c.status !== 'active' ? `<span class="badge status ${c.status}">${STATUS_LABEL[c.status]}</span>` : ''}
      ${c.carried ? '<span class="badge carried">交班结转</span>' : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(c.title)}<span class="rev-no">REV v${c.revision}</span></div>
      <div class="card-hazard">风险：${esc(c.hazard || '—')}</div>
      <div class="card-text">${esc(c.body)}</div>
      ${c.change_note && c.revision > 1 ? `<div class="change-note">本版变更：${esc(c.change_note)}</div>` : ''}
      <div class="card-meta">
        <span class="owner-pill">负责人：${c.owner ? esc(c.owner.name) + '（' + esc(c.owner.role) + '）' : '未指定'}</span>
        <span>进入时间：${new Date(c.added_at).toLocaleString('zh-CN')}</span>
      </div>
      <div class="people">${c.confirmations.map(p =>
        `<span class="person ${p.status}" title="${esc(PSTATUS_LABEL[p.status] || p.status)}${p.confirmed_at ? ' · ' + esc(p.confirmed_at) : ''}">
          ${esc(personName(p.person_id, p.person_name))}<span class="st">${esc(PSTATUS_LABEL[p.status] || p.status)}</span></span>`).join('')}
      </div>
    </div>
    <div class="card-foot">
      <div class="prog"><i style="width:${pct}%"></i></div>
      <span class="prog-txt">v${c.revision} ${c.progress.done}/${c.progress.total}</span>
      <button class="ack-btn" id="ack-${c.shift_card_id}" ${canAck ? '' : 'disabled'}>
        ${c.status === 'withdrawn' ? '卡片已撤回' :
          c.status === 'superseded' ? '旧版不可确认' :
          mine?.status === 'confirmed' ? `我已确认 v${c.revision}` :
          mine?.status === 'confirmed_late' ? `迟到回执 v${c.revision}` :
          !state.person ? '验证身份后确认' :
          !mine ? '非本班成员' : '确认已知悉'}
      </button>
    </div>
  </div>`;
}
function personName(id, fallback) {
  if (state.board?.members?.some(m => m.id === id)) {
    const m = state.board.members.find(x => x.id === id);
    return m.name;
  }
  return fallback || id;
}

// ---------- 身份验证 ----------
function openAuth() { $('authModal').classList.remove('hidden'); $('empId').focus(); }
function closeAuth() { $('authModal').classList.add('hidden'); $('authError').textContent = ''; $('empId').value=''; $('empPin').value=''; }
$('identifyBtn').addEventListener('click', openAuth);
$('idBottomBtn').addEventListener('click', openAuth);
$('authCancel').addEventListener('click', closeAuth);
$('authSubmit').addEventListener('click', doAuth);
$('empPin').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });

async function doAuth() {
  const employee_id = $('empId').value.trim();
  const pin = $('empPin').value.trim();
  $('authError').textContent = '';
  if (!navigator.onLine) { $('authError').textContent = '设备离线，无法验证身份；仍可查看提示，不能确认。'; return; }
  try {
    const r = await fetch('/api/auth/person', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, pin }),
    });
    const j = await r.json();
    if (!r.ok) { $('authError').textContent = j.error || '验证失败'; return; }
    state.token = j.token; state.person = j.person;
    closeAuth();
    toast('已验证：' + j.person.name + '（' + j.person.role + '）。共用终端请在每次确认前重新验证。');
    refresh(); loadCatchup();
  } catch (e) {
    $('authError').textContent = '网络错误；当前仅可查看，无法确认。';
  }
}

// ---------- 确认 ----------
function openAck(card) {
  if (!state.person) { openAuth(); return; }
  if (!navigator.onLine) { toast('设备离线：提示已保留显示，但不能确认；联网后可补确认。', 'err'); return; }
  state.pendingAck = card;
  $('confirmTitle').textContent = '确认已知悉：' + card.title;
  $('confirmMeta').innerHTML =
    `修订版本：<b>v${card.revision}</b>（${SRC_LABEL[card.source]}） · 班次：<b>${esc(state.board.shift.name)}</b>` +
    ` · 确认人：<b>${esc(state.person.name)}</b>（本人PIN已验证）<br>` +
    `负责人：${card.owner ? esc(card.owner.name) : '未指定'}`;
  $('confirmText').textContent = card.body;
  $('ackClock').checked = Math.abs(state.serverOffset) <= 60000;
  $('confirmError').textContent = '';
  $('confirmModal').classList.remove('hidden');
}
$('confirmCancel').addEventListener('click', () => $('confirmModal').classList.add('hidden'));
$('confirmSubmit').addEventListener('click', async () => {
  const card = state.pendingAck;
  if (!card) return;
  $('confirmError').textContent = '';
  try {
    const r = await fetch('/api/confirmations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ shift_card_id: card.shift_card_id, client_clock_ms: Date.now() }),
    });
    const j = await r.json();
    if (!r.ok) { $('confirmError').textContent = j.error || '确认失败'; return; }
    $('confirmModal').classList.add('hidden');
    // 两人共用终端：确认后清除身份，下一位必须重新验证
    state.token = null; state.person = null;
    state.pendingAck = null;
    toast((j.late ? '⏰ ' + j.notice : '✓ ' + j.notice) +
      (j.clock_warning ? '（检测到终端时钟偏差较大，已按服务器时间记录并标注）' : ''), j.late ? 'late' : 'ok');
    refresh(); loadCatchup();
  } catch (e) {
    $('confirmError').textContent = '网络错误，未生成确认记录（不会伪造确认）。';
  }
});

// ---------- 迟到回执 ----------
async function loadCatchup() {
  if (!state.token) { $('catchupPanel').hidden = true; return; }
  try {
    const r = await fetch('/api/my/catchup', { headers: { Authorization: 'Bearer ' + state.token } });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.items.length) { $('catchupPanel').hidden = true; return; }
    $('catchupPanel').hidden = false;
    $('catchupList').innerHTML = j.items.map(it => `
      <div class="catchup-item">
        <div class="ci-main">
          <div class="ci-tag">${esc(it.shift_name)} 已交班 · ${SRC_LABEL[it.source] || ''} · v${it.revision} · 交班于 ${it.closed_at ? new Date(it.closed_at).toLocaleString('zh-CN') : '—'}</div>
          <div class="ci-title">${esc(it.title)}</div>
          <div class="ci-sub">${esc(it.hazard)}</div>
        </div>
        <button class="ack-btn" data-cid="${esc(it.shift_card_id)}">补交迟到回执</button>
      </div>`).join('');
    $('catchupList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.cid;
      const r = await fetch('/api/confirmations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: JSON.stringify({ shift_card_id: id, client_clock_ms: Date.now() }),
      });
      const j = await r.json();
      if (!r.ok) { toast(j.error || '提交失败', 'err'); return; }
      toast('已记录迟到回执（v' + j.revision + '），不表示风险已消除。', 'late');
      state.token = null; state.person = null;
      refresh(); $('catchupPanel').hidden = true;
    }));
  } catch (_) {}
}

// ---------- 全屏（退出后操作仍可达：所有按钮始终保留在普通布局中） ----------
function toggleFs() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}
$('fullscreenBtn').addEventListener('click', toggleFs);
$('fsBottomBtn').addEventListener('click', toggleFs);
document.addEventListener('fullscreenchange', () => {
  $('fullscreenBtn').textContent = document.fullscreenElement ? '退出全屏' : '进入全屏';
});

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5200);
}

// ---------- 轮询 ----------
refresh();
setInterval(refresh, 10000);
