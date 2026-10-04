// Web 管理端
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const A = { token: localStorage.getItem('admin-token') || null, me: null };

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      A.token ? { Authorization: 'Bearer ' + A.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function toast(msg, isErr){ const t=$('#toast'); t.textContent=msg; t.className='toast'+(isErr?' err':'');
  setTimeout(()=>t.classList.add('hidden'),4500); }

// ---------- 模态 ----------
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal(){ $('#modal').classList.add('hidden'); $('#modalBox').innerHTML=''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ---------- 登录 ----------
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#lgErr').textContent = '';
  try {
    const j = await api('/api/auth/admin', { method: 'POST',
      body: { username: $('#lgUser').value.trim(), password: $('#lgPass').value } });
    A.token = j.token; A.me = j.admin; localStorage.setItem('admin-token', j.token);
    boot();
  } catch (err) { $('#lgErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch(_){}
  A.token = null; localStorage.removeItem('admin-token');
  $('#appView').hidden = true; $('#loginView').style.display = '';
});

$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tabpane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  loaders[t.dataset.tab]?.();
}));

// ---------- 数据缓存 ----------
const cache = { persons: [], cards: [], shifts: [] };
async function loadPersons(){ cache.persons = (await api('/api/admin/persons')).persons; }
async function loadCards(){ cache.cards = (await api('/api/admin/cards')).cards; }
async function loadShifts(){ cache.shifts = (await api('/api/admin/shifts')).shifts; }

// ============ 班次 ============
async function renderShifts() {
  await Promise.all([loadShifts(), loadPersons()]);
  $('#shiftList').innerHTML = cache.shifts.map(s => {
    const pct = s.total ? Math.round(s.done/s.total*100) : 0;
    const tag = s.status === 'active' ? '<span class="tag active">进行中</span>'
      : s.status === 'planned' ? '<span class="tag planned">待开班</span>'
      : '<span class="tag closed">已交班</span>';
    return `<div class="item-card">
      <h3>${esc(s.name)} ${tag}</h3>
      <div class="sub">${s.planned_start?esc(s.planned_start)+' – '+esc(s.planned_end):'未设定时段'}</div>
      <div class="sub">成员 ${s.member_count} 人 · 活动卡 ${s.card_count} 张</div>
      <div class="progress-line"><i style="width:${pct}%"></i></div>
      <div class="sub">确认 ${s.done}/${s.total}（${pct}%）</div>
      <div class="item-actions">
        <button class="btn btn-sm" data-act="detail" data-id="${s.id}">详情/清单对比</button>
        ${s.status==='planned'?`<button class="btn btn-sm btn-primary" data-act="activate" data-id="${s.id}">开班（冻结）</button>`:''}
        ${s.status==='active'?`
          <button class="btn btn-sm btn-warn" data-act="supplement" data-id="${s.id}">增补紧急卡</button>
          <button class="btn btn-sm" data-act="addmember" data-id="${s.id}">加入成员</button>
          <button class="btn btn-sm btn-danger" data-act="handover" data-id="${s.id}">交班结转</button>`:''}
      </div>
    </div>`;
  }).join('') || '<p class="muted">还没有班次，点击右上角新建。</p>';
  $('#shiftList').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    ({ detail: shiftDetail, activate: activateShift, supplement: supplementShift,
       addmember: addMember, handover: handoverShift })[b.dataset.act](id);
  }));
}

$('#newShiftBtn').addEventListener('click', async () => {
  await loadPersons();
  openModal(`<h3>新建班次</h3>
    <label>班次名称<input id="m-name" placeholder="如：10月4日 白班"></label>
    <div class="row2">
      <label>计划开始<input id="m-start" placeholder="08:00"></label>
      <label>计划结束<input id="m-end" placeholder="20:00"></label>
    </div>
    <label>班组成员（可开班前分配，也可班中加入）
      <div class="chk-list" id="m-members">
        ${cache.persons.filter(p=>p.active).map(p=>`<label><input type="checkbox" value="${esc(p.id)}"> ${esc(p.name)}（${esc(p.role)} · ${esc(p.id)}）</label>`).join('')}
      </div></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">创建（待开班）</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      await api('/api/admin/shifts', { method:'POST', body: {
        name: $('#m-name').value.trim(),
        planned_start: $('#m-start').value.trim(),
        planned_end: $('#m-end').value.trim(),
        person_ids: $$('#m-members input:checked').map(i=>i.value),
      }});
      closeModal(); toast('班次已创建为「待开班」；开班时冻结已发布卡片。'); renderShifts();
    } catch(e){ toast(e.message, true); }
  };
});

async function activateShift(id) {
  try {
    const j = await api('/api/admin/shifts/' + id + '/activate', { method:'POST', body:{} });
    const list = j.frozen.map(f => {
      const c = cache.cards.find(x=>x.id===f.card_id);
      return `· ${c?esc(c.title):f.card_id} v${f.revision}`;
    }).join('\n');
    openModal(`<h3>开班完成：清单已冻结</h3>
      <p>以下 ${j.frozen.length} 张已发布卡片按当前修订快照进班，并为全体成员生成待确认：</p>
      <div class="mig-box">${esc(list)||'（当时没有已发布卡片）'}</div>
      <p class="muted">开班后新增/换版的卡片进入「班中增补/换版」清单，与冻结清单分开追踪。</p>
      <div class="modal-actions"><button class="btn btn-primary" id="m-close">知道了</button></div>`);
    $('#m-close').onclick = () => { closeModal(); renderShifts(); };
  } catch(e) {
    if (/已有进行中班次/.test(e.message)) {
      openModal(`<h3>已有进行中的班次</h3><p>${esc(e.message)}</p>
        <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
        <button class="btn btn-warn" id="m-force">仍然并行开班</button></div>`);
      $('#m-cancel').onclick = closeModal;
      $('#m-force').onclick = async () => {
        await api('/api/admin/shifts/'+id+'/activate',{method:'POST',body:{force:true}});
        closeModal(); toast('已并行开班并冻结清单。'); renderShifts();
      };
    } else toast(e.message, true);
  }
}

async function supplementShift(id) {
  await loadCards();
  const j = await api('/api/admin/shifts/'+id);
  const inShift = new Set(j.board.cards.filter(c=>c.status==='active').map(c=>c.card_id));
  const opts = cache.cards.filter(c=>c.published && !c.withdrawn && !inShift.has(c.id));
  openModal(`<h3>班中增补紧急卡</h3>
    <p class="muted">增补卡立即进入本班，为全体在岗成员生成待确认；不影响已有冻结清单及其确认。</p>
    <label>选择卡片<select id="m-card">
      ${opts.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}（当前 v${c.current_revision}）</option>`).join('')}
    </select></label>
    ${opts.length===0?'<p class="muted">没有可增补的卡片（其它已发布卡均已在班）。</p>':''}
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-warn" ${opts.length?'':'disabled'} id="m-ok">立即增补并通知</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok') && ($('#m-ok').onclick = async () => {
    try {
      const r = await api('/api/admin/shifts/'+id+'/supplement',
        { method:'POST', body:{ card_id: $('#m-card').value, urgent: true }});
      closeModal(); toast(r.impact); renderShifts(); shiftDetail(id);
    } catch(e){ toast(e.message, true); }
  });
}

async function addMember(id) {
  await loadPersons();
  const j = await api('/api/admin/shifts/'+id);
  const inShift = new Set(j.board.members.map(m=>m.id));
  const opts = cache.persons.filter(p=>p.active && !inShift.has(p.id));
  openModal(`<h3>班中加入成员</h3>
    <p class="muted">加入后立即为当前所有活动卡（含增补卡）补建该成员的待确认。</p>
    <label>选择人员<select id="m-p">
      ${opts.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}（${esc(p.role)}）</option>`).join('')}
    </select></label>
    ${opts.length===0?'<p class="muted">没有可加入的人员。</p>':''}
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" ${opts.length?'':'disabled'} id="m-ok">加入本班</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok') && ($('#m-ok').onclick = async () => {
    await api('/api/admin/shifts/'+id+'/members',{method:'POST',body:{person_id:$('#m-p').value}});
    closeModal(); toast('已加入，并为活动卡片补建待确认。'); renderShifts(); shiftDetail(id);
  });
}

async function handoverShift(id) {
  openModal(`<h3>交班与结转</h3>
    <p>交班后：<br>① 未完成的确认项结转为「迟到回执」，原班次成员可在 C 窗口补交；<br>
    ② 已确认记录原样保留；<br>③ 迟到回执明确标注，不会改写为班中按时确认。</p>
    <label>交接备注<textarea id="m-note" placeholder="如：3号线动火许可卡未全员确认，已口头交接"></textarea></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-danger" id="m-ok">确认交班</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      const r = await api('/api/admin/shifts/'+id+'/handover',
        { method:'POST', body:{ note: $('#m-note').value.trim() }});
      closeModal(); toast(r.impact); renderShifts();
    } catch(e){ toast(e.message,true); }
  };
}

async function shiftDetail(id) {
  const [d] = await Promise.all([api('/api/admin/shifts/'+id)]);
  const b = d.board;
  $('#shiftDetail').hidden = false;
  $('#shiftDetail').innerHTML = `<h3>${esc(b.shift.name)} · 清单对比与状态迁移</h3>
    <div class="filters" style="margin:8px 0 12px">
      <span class="tag planned">整班冻结 ${b.lists_summary.frozen}</span>
      <span class="tag urgent">班中增补 ${b.lists_summary.supplement}</span>
      <span class="tag rev">班中换版(活动) ${b.lists_summary.revision}</span>
      <span class="tag" style="background:#eceff3;color:#67809a">已取代 ${b.lists_summary.superseded}</span>
      <span class="tag withdrawn">已撤回 ${b.lists_summary.withdrawn}</span>
      <span class="tag" style="background:#f3e6c6;color:#7a5a10">结转 ${b.lists_summary.carried}</span>
    </div>
    <div class="dlist">${b.cards.map(c => `
      <div class="dcard ${c.status!=='active'?'inactive':''}">
        <div class="dt">${esc(c.title)} <span class="tag rev">v${c.revision}</span>
          <span class="tag ${c.source==='frozen'?'planned':c.source==='supplement'?'urgent':'rev'}">
            ${({frozen:'冻结',supplement:'增补',revision:'换版'})[c.source]}</span>
          ${c.status!=='active'?`<span class="tag ${c.status==='withdrawn'?'withdrawn':''}">${({superseded:'已被新版取代',withdrawn:'已撤回'})[c.status]}</span>`:''}
          ${c.carried?'<span class="tag" style="background:#f3e6c6;color:#7a5a10">含结转</span>':''}
        </div>
        <div class="dm">负责人：${c.owner?esc(c.owner.name)+'（'+esc(c.owner.role)+'）':'未指定'} · 进入 ${new Date(c.added_at).toLocaleString('zh-CN')}</div>
        <div class="db">${esc(c.body)}</div>
        <div class="dm">确认进度（按本修订）：${c.progress.done}/${c.progress.total}
          ${c.change_note&&c.revision>1?' · 变更：'+esc(c.change_note):''}</div>
        <div>${c.confirmations.map(p=>`<span class="st ${p.status}" style="font-size:12px;margin-right:8px">
          ${esc(p.person_name)}：${({pending:'待确认',confirmed:'已确认',confirmed_late:'迟到回执',superseded:'旧版失效',withdrawn:'已撤回',carried:'待补交'})[p.status]||p.status}
          ${p.confirmed_at?'@'+new Date(p.confirmed_at).toLocaleTimeString('zh-CN'):''}</span>`).join('')}</div>
      </div>`).join('')}</div>`;
  $('#shiftDetail').scrollIntoView({ behavior:'smooth' });
}

// ============ 卡片 ============
async function renderCards() {
  await loadCards();
  $('#cardList').innerHTML = cache.cards.map(c => {
    const tag = c.withdrawn ? '<span class="tag withdrawn">已撤回</span>'
      : c.published ? '<span class="tag active">已发布</span>'
      : '<span class="tag draft">草稿</span>';
    return `<div class="item-card">
      <h3>${esc(c.title)} ${tag}</h3>
      <div class="sub">当前版本 <b>v${c.current_revision}</b> · 风险：${esc(c.hazard||'—')}</div>
      <div class="sub">${esc((c.body||'').slice(0,80))}…</div>
      <div class="item-actions">
        <button class="btn btn-sm" data-act="edit" data-id="${c.id}">${c.published?'发布新版（修订）':'编辑草稿'}</button>
        <button class="btn btn-sm" data-act="revs" data-id="${c.id}">修订历史</button>
        ${!c.published&&!c.withdrawn?`<button class="btn btn-sm btn-primary" data-act="publish" data-id="${c.id}">首发并进入进行中班</button>`:''}
        ${!c.withdrawn?`<button class="btn btn-sm btn-danger" data-act="withdraw" data-id="${c.id}">撤回</button>`:''}
      </div>
    </div>`;
  }).join('');
  $('#cardList').querySelectorAll('button').forEach(b => b.addEventListener('click',
    () => ({ edit: editCard, revs: revHistory, publish: publishCard, withdraw: withdrawCard })[b.dataset.act](b.dataset.id)));
}

function cardForm(c, onOk) {
  return `<h3>${c?'发布新版 · '+esc(c.title):'新建卡片（草稿）'}</h3>
    ${c?`<p class="muted">将创建 <b>v${c.current_revision+1}</b>：进行中班次的旧版待确认迁移为「已被新版取代」，
      已确认旧版者也要重新确认新版。</p>`:'<p class="muted">草稿不会进入任何班次，首发后才进入进行中的班次。</p>'}
    <label>标题<input id="m-title" value="${c?esc(c.title):''}"></label>
    <label>风险类型<input id="m-hazard" value="${c?esc(c.hazard):''}" placeholder="如：机械伤害 / 触电"></label>
    <label>提示正文<textarea id="m-body">${c?esc(c.body):''}</textarea></label>
    <div class="row2">
      <label>负责人<select id="m-owner">
        ${cache.persons.filter(p=>p.active).map(p=>`<option value="${esc(p.id)}" ${c&&c.owner_person_id===p.id?'selected':''}>${esc(p.name)}（${esc(p.role)}）</option>`).join('')}
      </select></label>
      <label>配图URL（留空则纯文字降级）<input id="m-img" value="${c?esc(c.image_url||''):''}" placeholder="/assets/card-crane.svg"></label>
    </div>
    <label>变更说明（新版必填）<input id="m-note" placeholder="如：新增3号线夜间作业要求"></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">${c?'发布 v'+(c.current_revision+1):'保存草稿'}</button></div>`;
}

$('#newCardBtn').addEventListener('click', async () => {
  await loadPersons();
  openModal(cardForm(null));
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      await api('/api/admin/cards', { method:'POST', body: {
        title: $('#m-title').value.trim(), body: $('#m-body').value.trim(),
        hazard: $('#m-hazard').value.trim(), owner_person_id: $('#m-owner').value,
        image_url: $('#m-img').value.trim() || null } });
      closeModal(); toast('草稿已保存，首发后进入进行中的班次。'); renderCards();
    } catch(e){ toast(e.message,true); }
  };
});

async function editCard(id) {
  await loadPersons();
  const c = cache.cards.find(x=>x.id===id);
  openModal(cardForm(c));
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      const body = {
        title: $('#m-title').value.trim(), body: $('#m-body').value.trim(),
        hazard: $('#m-hazard').value.trim(),
        owner_person_id: $('#m-owner').value,
        image_url: $('#m-img').value.trim() || null,
        change_note: $('#m-note').value.trim(),
      };
      if (c.published) {
        if (!body.change_note) return toast('修订必须填写变更说明', true);
        const j = await api('/api/admin/cards/'+id+'/revise', { method:'POST', body });
        closeModal();
        const mig = j.migrations.map(m => m.effect==='migrated'
          ? `· 班次 ${m.shift_id.slice(0,12)}：v${m.old_revision} 未确认 ${m.pending_moved} 项迁移失效，v${m.new_revision} 全员 ${m.member_count} 人重认`
          : `· 班次 ${m.shift_id.slice(0,12)}：新卡增补进入 v${m.revision}`).join('\n');
        openModal(`<h3>新版已发布</h3><div class="mig-box">${esc(mig)||'（当前无进行中班次；后续开班将冻结新版）'}</div>
          <div class="modal-actions"><button class="btn btn-primary" id="m-close">知道了</button></div>`);
        $('#m-close').onclick = () => { closeModal(); renderCards(); };
      } else {
        // 草稿就地更新：删除重建
        await api('/api/admin/cards', { method:'POST', body: {
          title: body.title, body: body.body, hazard: body.hazard,
          owner_person_id: body.owner_person_id, image_url: body.image_url } });
        closeModal(); toast('草稿已更新（旧草稿未发布可忽略）。'); renderCards();
      }
    } catch(e){ toast(e.message,true); }
  };
}

async function publishCard(id) {
  try {
    const j = await api('/api/admin/cards/'+id+'/publish', { method:'POST', body:{} });
    closeModal();
    const mig = j.migrations.map(m=>`· 班次 ${m.shift_id.slice(0,12)}：以紧急增补进入 v1（${m.pending_created??''}）`).join('\n');
    toast('首发成功。'+(mig?'已增补进 '+j.migrations.length+' 个进行中班次。':'当前无进行中班次。'));
    renderCards();
  } catch(e){ toast(e.message,true); }
}

async function withdrawCard(id) {
  const c = cache.cards.find(x=>x.id===id);
  openModal(`<h3>撤回卡片：${esc(c.title)}</h3>
    <p class="muted">撤回后：进行中班次中该卡的<b>未确认</b>项立即迁移为「已撤回」、不能再确认；
    已有的历史确认保留可追溯。撤回不影响其它卡片。</p>
    <label>撤回原因<input id="m-reason" placeholder="如：提示内容有误，待重新编制"></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-danger" id="m-ok">确认撤回</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const j = await api('/api/admin/cards/'+id+'/withdraw',
      { method:'POST', body:{ reason: $('#m-reason').value.trim() }});
    closeModal();
    toast('已撤回；'+j.effects.map(e=>e.pending_moved+' 项未确认迁移为已撤回').join('，')||'无进行中影响。');
    renderCards();
  };
}

async function revHistory(id) {
  const j = await api('/api/admin/cards/'+id+'/revisions');
  openModal(`<h3>修订历史</h3>
    ${j.revisions.map(r=>`<div class="dcard" style="margin-bottom:10px">
      <div class="dt">v${r.revision} · ${new Date(r.published_at).toLocaleString('zh-CN')} · ${esc(r.published_by)}</div>
      <div class="dm">${esc(r.title)} · ${esc(r.hazard||'')}</div>
      <div class="db">${esc(r.body)}</div>
      <div class="dm">变更说明：${esc(r.change_note||'—')}</div>
    </div>`).join('')}
    <div class="modal-actions"><button class="btn" id="m-close">关闭</button></div>`);
  $('#m-close').onclick = closeModal;
}

// ============ 人员 ============
async function renderPersons() {
  await loadPersons();
  $('#personTable tbody').innerHTML = cache.persons.map(p => `<tr>
    <td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>${esc(p.role)}</td>
    <td>${p.active?'<span class="tag active">在岗</span>':'<span class="tag withdrawn">停用</span>'}</td>
    <td><button class="btn btn-sm" data-pin="${esc(p.id)}">重置PIN</button>
        ${p.active?`<button class="btn btn-sm btn-danger" data-deact="${esc(p.id)}">停用</button>`:''}</td>
  </tr>`).join('');
  $('#personTable').querySelectorAll('[data-pin]').forEach(b => b.onclick = () => resetPin(b.dataset.pin));
  $('#personTable').querySelectorAll('[data-deact]').forEach(b => b.onclick = async () => {
    if (!confirm('停用后该人员无法再验证身份确认。继续？')) return;
    await api('/api/admin/persons/'+b.dataset.deact+'/deactivate',{method:'POST'});
    toast('已停用'); renderPersons();
  });
}
function resetPin(id) {
  openModal(`<h3>重置 PIN</h3><label>新 PIN（4-6位数字）<input id="m-pin" inputmode="numeric" maxlength="6"></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">保存</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try { await api('/api/admin/persons/'+id+'/reset-pin',{method:'POST',body:{pin:$('#m-pin').value.trim()}});
      closeModal(); toast('PIN 已重置');
    } catch(e){ toast(e.message,true); }
  };
}
$('#newPersonBtn').addEventListener('click', () => {
  openModal(`<h3>新增人员</h3>
    <label>工号<input id="m-id" placeholder="p_xxx"></label>
    <label>姓名<input id="m-name"></label>
    <label>角色<input id="m-role" placeholder="操作工/班长/维修工"></label>
    <label>初始 PIN（4-6位数字）<input id="m-pin" inputmode="numeric" maxlength="6" value="123456"></label>
    <div class="modal-actions"><button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">保存</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      await api('/api/admin/persons',{method:'POST',body:{
        employee_id:$('#m-id').value.trim(), name:$('#m-name').value.trim(),
        role:$('#m-role').value.trim(), pin:$('#m-pin').value.trim() }});
      closeModal(); toast('人员已创建'); renderPersons();
    } catch(e){ toast(e.message,true); }
  };
});

// ============ 追溯 ============
const ST_ZH = { pending:'待确认', confirmed:'已确认', confirmed_late:'迟到回执',
  superseded:'旧版失效', withdrawn:'已撤回', carried:'待补交(结转)' };
async function renderTraces() {
  await Promise.all([loadShifts(), loadCards(), loadPersons()]);
  $('#fShift').innerHTML = '<option value="">全部班次</option>' +
    cache.shifts.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#fCard').innerHTML = '<option value="">全部卡片</option>' +
    cache.cards.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  $('#fPerson').innerHTML = '<option value="">全部人员</option>' +
    cache.persons.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const q = new URLSearchParams();
  if ($('#fShift').value) q.set('shift_id',$('#fShift').value);
  if ($('#fCard').value) q.set('card_id',$('#fCard').value);
  if ($('#fPerson').value) q.set('person_id',$('#fPerson').value);
  const j = await api('/api/admin/traces?'+q.toString());
  $('#traceTable tbody').innerHTML = j.confirmations.map(c => {
    const skew = c.clock_skew_ms;
    const skewTxt = skew==null ? '—'
      : (skew/1000).toFixed(1)+'s'+(Math.abs(skew)>60000?' ⚠':'');
    return `<tr>
      <td>${c.confirmed_at?new Date(c.confirmed_at).toLocaleString('zh-CN'):'—'}</td>
      <td>${esc(c.person.name)}</td>
      <td>${c.shift?esc(c.shift.name):esc(c.shift||'')}</td>
      <td>${esc(c.card_title)}<br><span class="muted">${esc(c.card_id)}</span></td>
      <td><b>v${c.revision}</b><br><span class="muted">${({frozen:'冻结',supplement:'增补',revision:'换版'})[c.source]||''}</span></td>
      <td>${({frozen:'整班冻结',supplement:'班中增补',revision:'班中换版'})[c.source]||'—'}</td>
      <td><span class="st ${c.status}">${ST_ZH[c.status]||c.status}</span>${c.late?' <span class="muted">(交班后)</span>':''}</td>
      <td class="${Math.abs(skew||0)>60000?'skew-warn':''}">${skewTxt}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无记录</td></tr>';
}
$('#traceRefresh').onclick = renderTraces;
['fShift','fCard','fPerson'].forEach(id => $('#'+id).onchange = renderTraces);

// ============ 审计 ============
async function renderAudit() {
  const j = await api('/api/admin/audit');
  $('#auditTable tbody').innerHTML = j.logs.map(l => `<tr>
    <td>${new Date(l.at_ts).toLocaleString('zh-CN')}</td>
    <td>${esc(l.actor_type)}:${esc(l.actor_id||'—')}${l.shift_id?'<br><span class="muted">'+esc(l.shift_id.slice(0,14))+'</span>':''}</td>
    <td><b>${esc(l.action)}</b></td>
    <td><code style="font-size:11.5px;white-space:pre-wrap">${esc(JSON.stringify(l.detail,null,0))}</code></td>
  </tr>`).join('');
}
$('#auditRefresh').onclick = renderAudit;

const loaders = { shifts: renderShifts, cards: renderCards, persons: renderPersons,
  traces: renderTraces, audit: renderAudit };

async function boot() {
  if (!A.token) return;
  try {
    const me = await api('/api/auth/me');
    if (me.type !== 'admin') throw new Error('session type');
    A.me = me.admin;
  } catch(_) { A.token = null; localStorage.removeItem('admin-token'); location.reload(); return; }
  $('#loginView').style.display = 'none'; $('#appView').hidden = false;
  $('#whoName').textContent = A.me ? A.me.name : '管理员';
  renderShifts();
}
boot();
