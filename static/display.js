'use strict';
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let TOKEN = null, ME = null;           // 仅内存：两人共用终端，刷新/换人需重新验证
let SID = Number(localStorage.getItem('safety_sid')) || null;
let BUNDLE = null;                     // 最新在线数据
let clockSkew = 0, online = navigator.onLine, fetchOK = false;
const POLL_MS = 20000;

const toastEl = $('#toast'); let tTimer;
function toast(msg, kind='') {
  toastEl.textContent = msg; toastEl.className = 'toast '+kind;
  toastEl.style.display = 'block';
  clearTimeout(tTimer); tTimer = setTimeout(()=>toastEl.style.display='none', 5000);
}
const tag = (c,t)=>`<span class="tag ${c}">${esc(t)}</span>`;
const STATUS_CN = {pending:'待确认',confirmed:'全员已确认',superseded:'已被新版取代',withdrawn:'已撤回'};

// ---------- 存储 ----------
const cacheKey = sid => `safety_bundle_${sid}`;
const OUTBOX_KEY = 'safety_outbox_v1';
const getOutbox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)||'[]'); } catch(e){ return []; } };
const setOutbox = a => localStorage.setItem(OUTBOX_KEY, JSON.stringify(a));

async function api(path, opts={}) {
  const res = await fetch(path, {
    method:opts.method||'GET',
    headers:Object.assign({'Content-Type':'application/json'}, TOKEN?{'Authorization':'Bearer '+TOKEN}:{}),
    body: opts.body?JSON.stringify(opts.body):undefined,
    cache:'no-store'});
  let data={}; try{data=await res.json();}catch(e){}
  if(!res.ok){const e=new Error(data.message||'HTTP '+res.status);e.code=data.error;e.data=data;e.status=res.status;throw e;}
  return data;
}

// ---------- 身份 ----------
function setIdentity(p) {
  ME = p;
  $('#identity').textContent = p ? `已验证：${p.name} (${p.employee_no})` : '未验证身份（仅可查看）';
  $('#btn-login').style.display = p ? 'none' : 'inline-block';
  $('#btn-switch').style.display = p ? 'inline-block' : 'none';
}
let modalAction = null;
function openModal(mode) {
  $('#m-title').textContent = mode==='reverify' ? '确认前再次验证' : '验证身份';
  $('#m-desc').textContent = mode==='reverify'
    ? '两人共用终端：执行知悉确认前再次校验 PIN。验证失败不会写入任何确认。'
    : '未通过身份验证只能查看提示，系统不会代填或伪造确认。';
  $('#m-no').value = ME && mode==='reverify' ? ME.employee_no : '';
  $('#m-no').disabled = mode==='reverify';
  $('#m-pin').value = '';
  $('#m-extra').innerHTML = '';
  modalAction = mode;
  $('#modal-mask').style.display = 'flex';
  setTimeout(()=>$('#m-pin').focus(), 50);
}
function closeModal(){ $('#modal-mask').style.display='none'; modalAction=null; }
$('#m-cancel').onclick = closeModal;
$('#btn-login').onclick = () => openModal('login');
$('#btn-switch').onclick = async () => {
  if (TOKEN) { try { await api('/api/auth/logout',{method:'POST'}); } catch(e){} }
  TOKEN=null; setIdentity(null); toast('已退出当前人员；下一位请重新验证身份'); renderCards();
};
$('#m-ok').onclick = async () => {
  const no = $('#m-no').value.trim(), pin = $('#m-pin').value;
  try {
    if (modalAction==='login') {
      const d = await api('/api/auth/login',{method:'POST',body:{employee_no:no,pin,purpose:'display'}});
      TOKEN=d.token; setIdentity(d.person);
      closeModal(); toast(`身份已验证：${d.person.name}`); await refresh(true);
    } else { // reverify
      await api('/api/auth/verify-pin',{method:'POST',body:{pin}});
      closeModal(); doConfirm(pendingConfirmEntry);
    }
  } catch(e) {
    $('#m-extra').innerHTML = `<p class="imgfail" style="margin-top:10px">${esc(e.message)}</p>`;
  }
};

// ---------- 班次 ----------
async function loadShifts() {
  try {
    const d = await api('/api/shifts');
    $('#shift-sel').innerHTML = d.shifts.map(s =>
      `<option value="${s.id}">${esc(s.name)}${s.handed_over?'（已交班）':''}</option>`).join('');
    if (!SID || !d.shifts.some(s=>s.id===SID)) SID = d.shifts[0]?.id || null;
    $('#shift-sel').value = SID;
  } catch(e) {
    // 离线时无法获取班次列表：沿用本地缓存的 SID
    $('#shift-sel').innerHTML = SID?`<option value="${SID}">班次 #${SID}（离线）</option>`:'';
  }
}
$('#shift-sel').onchange = async () => {
  SID = Number($('#shift-sel').value);
  localStorage.setItem('safety_sid', SID);
  BUNDLE = null;
  await refresh(true);
};

// ---------- 拉取 / 离线 ----------
async function refresh(manual=false) {
  if (!SID) { renderCards(); return; }
  try {
    const d = await api(`/api/display/${SID}`);
    fetchOK = true; online = true;
    const local = new Date();
    const srv = new Date(d.server_time);
    clockSkew = Math.round((local - srv)/1000);
    localStorage.setItem(cacheKey(SID), JSON.stringify({data:d, fetched_at:new Date().toISOString()}));
    BUNDLE = d;
    if (ME && d.viewer && d.viewer.id!==ME.id) { /* 会话身份以本地为准 */ }
    if (!ME && d.viewer && TOKEN) setIdentity(d.viewer);
    renderHead(); renderCards();
    replayOutbox();
  } catch(e) {
    if (e instanceof TypeError || e.message.includes('Failed to fetch') || e.message==='Network request failed') {
      online = false;
    } else if (e.code==='BAD_SESSION' || e.code==='SESSION_EXPIRED' || e.code==='NO_SESSION') {
      TOKEN=null; setIdentity(null); online=true;
    }
    const cached = localStorage.getItem(cacheKey(SID));
    if (cached) { BUNDLE = JSON.parse(cached).data; }
    fetchOK = false;
    renderHead(); renderCards();
    if (manual && !BUNDLE) toast('离线且本机没有该班次的保留提示', 'err');
  }
}
window.addEventListener('online', ()=>{ refresh(true); });
window.addEventListener('offline', renderHead);

function renderHead() {
  const b = BUNDLE;
  $('#sync').textContent = fetchOK ? `已同步 · 偏差${clockSkew}s${Math.abs(clockSkew)>60?' ⚠':''}` : '离线（展示保留提示）';
  $('#sync').style.color = fetchOK ? (Math.abs(clockSkew)>60?'var(--warn)':'#88e0a8') : '#ffb0b0';
  if (b) {
    $('#ov-shift').textContent = b.shift.name + (b.shift.handed_over?'（已交班）':'');
    $('#ov-window').textContent = `班次窗口 ${b.shift.start_at} → ${b.shift.end_at}` +
      (b.shift.handed_over?` · 交班 ${b.shift.handed_over_at}（此后知悉均记为交班后迟到回执）`:'');
    const cachedAt = JSON.parse(localStorage.getItem(cacheKey(SID))||'{}').fetched_at;
    $('#ov-updated').textContent = '数据更新时间(服务器)：' + b.server_time +
      '\n本机获取：' + (cachedAt||'—');
    const fr = b.entries.filter(e=>e.list_type==='frozen' && e.status!=='withdrawn').length;
    const sp = b.entries.filter(e=>e.list_type==='supplement' && e.status!=='withdrawn').length;
    $('#ov-frozen').innerHTML = tag('frozen',`整班冻结 ${fr}`)+' '+tag('supplement',`班中增补 ${sp}`);
  } else {
    $('#ov-shift').textContent = SID?`班次 #${SID}`:'请选择班次';
    $('#ov-window').textContent = fetchOK?'':'';
    $('#ov-updated').textContent = '更新时间：—';
  }
  const ob = $('#offline-banner');
  if (!fetchOK) {
    const cachedAt = JSON.parse(localStorage.getItem(cacheKey(SID))||'{}').fetched_at;
    $('#offline-since').textContent = cachedAt || '未知';
    ob.style.display='block';
  } else ob.style.display='none';
}

// ---------- 卡片渲染（文字始终完整呈现，图片只是增强） ----------
function renderCards() {
  const box = $('#cards');
  if (!BUNDLE) {
    box.innerHTML = `<div class="rcard"><div class="rcard-title">暂无可用提示数据</div>
      <div class="hint">${fetchOK?'该班次没有在班提示。':'设备离线，且本机未保留该班次的提示。'}</div></div>`;
    return;
  }
  const outbox = getOutbox().filter(o => o.shift_id === SID);
  const memberIds = BUNDLE.members.map(m=>m.id);
  $('#cards').innerHTML = BUNDLE.entries.map(e => {
    const r = e.revision;
    const queued = outbox.filter(o=>o.entry_id===e.id);
    const confirmedIds = new Set(e.confirmed_by.map(c=>c.person_id));
    queued.forEach(o=>confirmedIds.add(o.person_id));   // 离线待补传也展示，明确标注“待补传”
    const chips = BUNDLE.members.map(m =>
      confirmedIds.has(m.id)
        ? (queued.some(o=>o.person_id===m.id)
            ? `<span class="chip miss">${esc(m.name)}：待补传</span>`
            : `<span class="chip">✓ ${esc(m.name)} 已知悉</span>`)
        : `<span class="chip miss">${esc(m.name)} 未确认</span>`).join('');
    const isMember = ME && memberIds.includes(ME.id);
    const iConfirmed = ME && e.confirmed_by.some(c=>c.person_id===ME.id);
    const iQueued = queued.some(o=>o.person_id===(ME&&ME.id));
    const superseded = e.status==='superseded';
    let actions = '';
    if (superseded) {
      actions = `<div class="hint">⛔ 该<b>第${r.rev}版</b>已被班中增补的新版本取代。旧确认保留在本版，
        不能确认此旧版，也不会覆盖新风险——请在新版卡片上知悉确认。</div>`;
    } else if (!ME) {
      actions = `<button class="btn-confirm" onclick="askConfirm(${e.id})">验证身份后知悉确认</button>
        <div class="hint">未验证身份仅可查看，不会产生确认。</div>`;
    } else if (!isMember) {
      actions = `<div class="hint">你不是本班当班人员，仅可查看，不能代他人确认。</div>`;
    } else if (iConfirmed) {
      actions = tag('confirmed','你已知悉本版')+`<div class="hint">知悉确认不代表风险已消除；若该卡再出新版，需重新知悉新版。</div>`;
    } else if (iQueued) {
      actions = tag('pending','离线待补传')+`<div class="hint">恢复连接后按本版 hash 补传；若已换版，需重新确认新版。</div>`;
    } else {
      const lateWarn = BUNDLE.shift.handed_over ? '本班已交班，现在确认将记为<b>交班后迟到回执</b>。' : '';
      actions = `<button class="btn-confirm" onclick="askConfirm(${e.id})">我已知悉第${r.rev}版提示</button>
        <div class="hint">${lateWarn}按钮仅表示已知悉<b>该版本</b>提示，<b>不表示风险已消除</b>。</div>`;
    }
    const img = r.image_url
      ? `<img class="rcard-img" src="${esc(r.image_url)}" alt="提示配图"
           onload="this.dataset.ok=1" onerror="this.outerHTML='<div class=&quot;imgfail&quot;>⚠ 配图解码失败/缺失：以下文字内容完整保留，不影响提示传达。</div>'">`
      : `<div class="imgfail">本卡无图片，为纯文字提示（设计即如此，非故障）。</div>`;
    return `<div class="rcard ${e.list_type==='supplement'?'supp':''} ${superseded?'superseded':''}">
      <div class="rcard-head">
        <span class="rcard-title">${esc(r.title)}</span>
        ${e.list_type==='frozen'?tag('frozen','整班冻结'):tag('supplement','⛑ 班中增补')}
        ${tag(e.status==='confirmed'?'confirmed':e.status==='superseded'?'superseded':'pending', STATUS_CN[e.status]||e.status)}
        <span class="muted small">第${r.rev}版 · ${esc(r.content_hash)}</span>
      </div>
      ${img}
      <div class="rcard-resp">当班负责人：${esc(r.responsible)||'<span class="muted">未指定</span>'}</div>
      <div class="rcard-risk">⚠ ${esc(r.risk_text)}</div>
      <div class="rcard-meas">🛡 ${esc(r.measure_text)||'按现场安全规程执行'}</div>
      <div class="confirmers">${chips}</div>
      <div class="rcard-actions">${actions}</div>
    </div>`;
  }).join('');
}

// ---------- 确认 ----------
let pendingConfirmEntry = null;
window.askConfirm = function(entryId) {
  if (!ME) { pendingConfirmEntry = entryId; openModal('login'); return; }
  pendingConfirmEntry = entryId;
  openModal('reverify');  // 关键动作二次验证
};

async function doConfirm(entryId) {
  if (entryId==null) return;
  const e = BUNDLE.entries.find(x=>x.id===entryId);
  if (!e) return;
  const payload = {entry_id:e.id, card_revision_id:e.card_revision_id,
                   client_clock:new Date().toISOString()};
  const send = async (offline) => api(`/api/display/${SID}/confirm`,
    {method:'POST', body:Object.assign({offline:!!offline}, payload)});
  try {
    const r = await send(false);
    await refresh(true);
    if (r.idempotent) toast('此前已确认过该版本（幂等）', 'ok');
    else toast(r.timing==='ON_TIME'
      ? '已记录：你已知悉本版提示（不代表风险已消除）'
      : '已记录为“交班后迟到回执”，已如实标注', r.timing==='ON_TIME'?'ok':'err');
    if (Math.abs(r.clock_skew_secs||0)>60) toast('本机时钟与服务器相差 '+r.clock_skew_secs+' 秒，已标记 ⚠','err');
  } catch(err) {
    if (err instanceof TypeError || String(err.message).includes('Failed to fetch')) {
      // 离线：暂存，绑定具体修订与当前已验证人员
      const ob = getOutbox();
      if (!ob.some(o=>o.entry_id===e.id && o.person_id===ME.id)) {
        ob.push(Object.assign({shift_id:SID, person_id:ME.id, name:ME.name, rev:e.revision.rev}, payload));
        setOutbox(ob);
      }
      toast('设备离线：确认已暂存本机并绑定第'+e.revision.rev+'版，恢复后补传；若期间换版需重新确认新版','err');
      renderCards();
    } else if (err.code==='SUPERSEDED' || err.code==='REVISION_MISMATCH') {
      toast(err.message+'（未写入任何确认）','err');
      await refresh(true);
    } else {
      toast(err.message,'err');
    }
  }
  pendingConfirmEntry = null;
}

// ---------- 离线补传 ----------
async function replayOutbox() {
  let ob = getOutbox();
  if (!ob.length || !fetchOK || !TOKEN) return;
  const rest = [];
  for (const o of ob) {
    if (!ME || o.person_id !== ME.id) { rest.push(o); continue; }  // 只补传本人的，防止共用终端冒用
    try {
      await api(`/api/display/${o.shift_id}/confirm`,{method:'POST',body:{
        entry_id:o.entry_id, card_revision_id:o.card_revision_id,
        client_clock:o.client_clock, offline:true}});
      toast(`已补传一条离线知悉（条目#${o.entry_id}，第${o.rev}版）`,'ok');
    } catch(e) {
      if (e.code==='SUPERSEDED' || e.code==='REVISION_MISMATCH') {
        toast(`离线确认未补传：条目#${o.entry_id} 所绑版本已更新，请对新版重新确认（旧记录未伪造到新版）`,'err');
        continue; // 丢弃：不迁移、不覆盖
      }
      if (e.code==='WITHDRAWN') { toast(`条目#${o.entry_id} 已被撤回，离线确认无需补传`); continue; }
      if (e.code==='BAD_SESSION'||e.code==='SESSION_EXPIRED'||e.code==='NO_SESSION') {
        TOKEN=null; setIdentity(null); rest.push(o); continue;
      }
      if (e.code==='NOT_SHIFT_MEMBER') { toast('离线确认被拒：非当班人员，已丢弃','err'); continue; }
      rest.push(o); // 其他错误（如网络抖动）保留
    }
  }
  setOutbox(rest);
  await refresh(false);
}

// ---------- 全屏（退出全屏后顶栏操作仍全部可达） ----------
$('#btn-fs').onclick = () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
};
document.addEventListener('fullscreenchange', () => {
  $('#btn-fs').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});

// 宣传图解码失败 → 文字降级背景（内容不丢失，提示在卡片中）
$('#poster').addEventListener('error', () => {
  $('#poster').style.display='none';
  $('#poster-fallback').style.display='flex';
});

// ---------- 启动 ----------
(async function main(){
  await loadShifts();
  await refresh(true);
  setInterval(refresh, POLL_MS);
})();
