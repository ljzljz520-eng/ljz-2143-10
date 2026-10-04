'use strict';
// ---------- 基础 ----------
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let TOKEN = localStorage.getItem('admin_token') || '';
let ME = null;

async function api(path, opts={}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: Object.assign({'Content-Type':'application/json'},
      TOKEN ? {'Authorization':'Bearer '+TOKEN} : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) {
    const err = new Error(data.message || ('HTTP '+res.status));
    err.code = data.error; err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
let toastTimer;
function toast(msg, kind='') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.style.display = 'none', 4200);
}
function tag(cls, text) { return `<span class="tag ${cls}">${esc(text)}</span>`; }
const STATUS_CN = {draft:'草稿',approved:'已审核',withdrawn:'已撤回',
  pending:'待确认',confirmed:'全员已确认',superseded:'已被新版取代'};
const TIMING_CN = {ON_TIME:'按时',LATE_BEFORE_HANDOVER:'迟到(交班未办理)',LATE_AFTER_HANDOVER:'交班后迟到回执'};

// ---------- 登录 ----------
async function login() {
  try {
    const d = await api('/api/auth/login', {method:'POST', body:{
      employee_no: $('#li-no').value.trim(), pin: $('#li-pin').value, purpose:'admin'}});
    if (!d.person.is_admin) throw new Error('该账号不是管理员');
    TOKEN = d.token; ME = d.person;
    localStorage.setItem('admin_token', TOKEN);
    showApp();
  } catch(e) { toast(e.message, 'err'); }
}
async function logout() {
  try { await api('/api/auth/logout', {method:'POST'}); } catch(e) {}
  TOKEN=''; ME=null; localStorage.removeItem('admin_token');
  $('#app').style.display='none'; $('#login').style.display='block';
}
async function showApp() {
  $('#login').style.display='none'; $('#app').style.display='block';
  $('#who').textContent = `${ME.name} (${ME.employee_no})`;
  switchTab('cards');
}
$$('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
function switchTab(name) {
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  ['cards','shifts','ledger','persons','events'].forEach(t =>
    $('#tab-'+t).style.display = t===name ? 'block':'none');
  ({cards:renderCards, shifts:renderShifts, ledger:renderLedger,
    persons:renderPersons, events:renderEvents})[name]().catch(e => toast(e.message,'err'));
}

// ---------- 卡片与审核 ----------
async function renderCards() {
  const d = await api('/api/cards');
  const el = $('#tab-cards');
  el.innerHTML = `
    <div class="panel">
      <h3>新建卡片（首版为草稿，需人工审核后才能进入班次）</h3>
      <div class="row">
        <div style="flex:2"><label>标题 *</label><input id="c-title"></div>
        <div><label>负责人</label><input id="c-resp"></div>
      </div>
      <label>当班风险（必须有文字，图片失败时仍可降级展示）*</label><textarea id="c-risk"></textarea>
      <div class="row">
        <div style="flex:2"><label>防护措施提示</label><textarea id="c-meas"></textarea></div>
        <div><label>宣传图 URL（可空，可填错误地址验收降级）</label><input id="c-img" placeholder="/static/poster.svg"></div>
      </div>
      <div style="margin-top:10px"><button id="c-create">创建草稿</button></div>
    </div>
    <div id="c-list"></div>`;
  $('#c-create').onclick = async () => {
    try {
      await api('/api/cards', {method:'POST', body:{
        title:$('#c-title').value, risk_text:$('#c-risk').value,
        measure_text:$('#c-meas').value, responsible:$('#c-resp').value,
        image_url:$('#c-img').value || null}});
      toast('已创建草稿；审核通过后才能进入班次', 'ok'); renderCards();
    } catch(e){ toast(e.message,'err'); }
  };
  $('#c-list').innerHTML = d.cards.map(c => {
    const revs = c.revisions.map(r => `
      <div class="rev">
        <div>${tag(r.status, STATUS_CN[r.status])} <b>第 ${r.rev} 版</b>
          <span class="muted small">hash ${esc(r.content_hash)}</span></div>
        <div class="small" style="margin:6px 0">
          <b>${esc(r.title)}</b> · 负责人 ${esc(r.responsible)||'<span class="muted">未指定</span>'}<br>
          风险：${esc(r.risk_text)}<br>措施：${esc(r.measure_text)||'<span class="muted">无</span>'}
          ${r.image_url ? `<br>图片：<span class="muted">${esc(r.image_url)}</span>` : '<br><span class="muted">无图片（纯文字）</span>'}
          <br><span class="muted">审核时间 ${r.approved_at?esc(r.approved_at):'—'}</span>
        </div>
        <div style="display:flex;gap:8px">
          ${r.status==='draft' ? `<button data-act="approve" data-rid="${r.id}">人工审核通过</button>` : ''}
          <button class="secondary" data-act="revise" data-cid="${c.id}">据此修订出新版本</button>
          ${r.status==='approved' ? `<button class="danger" data-act="withdraw" data-cid="${c.id}">撤回该卡片</button>` : ''}
        </div>
      </div>`).join('');
    return `<div class="panel"><h3>🗂 ${esc(c.title)}</h3>${revs}</div>`;
  }).join('') || '<p class="muted">暂无卡片</p>';

  $$('#c-list button').forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    try {
      if (act==='approve') {
        await api(`/api/revisions/${b.dataset.rid}/approve`,{method:'POST'});
        toast('已审核通过：该版本现可进入冻结/增补清单','ok');
      } else if (act==='withdraw') {
        if (!confirm('撤回后在班条目立即标记为已撤回，仍需当班人员知悉？历史确认保留。')) return;
        const r = await api(`/api/cards/${b.dataset.cid}/withdraw`,{method:'POST'});
        toast(`已撤回，影响在班条目 ${r.entries_withdrawn.length} 项`,'ok');
      } else if (act==='revise') {
        return reviseCard(b.dataset.cid);
      }
      renderCards();
    } catch(e){ toast(e.message,'err'); }
  });
}
async function reviseCard(cid) {
  const d = await api('/api/cards');
  const c = d.cards.find(x => x.id===Number(cid));
  const r0 = c.revisions[0];
  const el = $('#tab-cards');
  el.insertAdjacentHTML('afterbegin', `
    <div class="panel" id="revbox" style="border-color:var(--supp)">
      <h3>为「${esc(c.title)}」创建新版本（草稿，审核后通过班中增补进入在班清单）</h3>
      <label>标题</label><input id="r-title" value="${esc(r0.title)}">
      <label>当班风险 *</label><textarea id="r-risk">${esc(r0.risk_text)}</textarea>
      <div class="row">
        <div style="flex:2"><label>防护措施</label><textarea id="r-meas">${esc(r0.measure_text)}</textarea></div>
        <div><label>负责人</label><input id="r-resp" value="${esc(r0.responsible)}"></div>
      </div>
      <label>图片 URL</label><input id="r-img" value="${esc(r0.image_url||'')}">
      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="r-save">生成新版本草稿</button>
        <button class="ghost" id="r-cancel">取消</button></div>
    </div>`);
  $('#r-cancel').onclick = renderCards;
  $('#r-save').onclick = async () => {
    try {
      const r = await api(`/api/cards/${cid}/revisions`,{method:'POST',body:{
        title:$('#r-title').value, risk_text:$('#r-risk').value,
        measure_text:$('#r-meas').value, responsible:$('#r-resp').value,
        image_url:$('#r-img').value||null}});
      toast(`已生成第 ${r.rev} 版草稿，审核后再于班次中“增补”`,'ok');
      renderCards();
    } catch(e){ toast(e.message,'err'); }
  };
}

// ---------- 班次 ----------
async function renderShifts() {
  const d = await api('/api/shifts');
  const el = $('#tab-shifts');
  el.innerHTML = `
    <div class="panel">
      <h3>创建班次</h3>
      <div class="row">
        <div style="flex:2"><label>班次名称</label><input id="s-name" placeholder="如 夜班-检修乙班"></div>
        <div><label>上班时间(ISO8601 UTC)</label><input id="s-start"></div>
        <div><label>下班时间(ISO8601 UTC)</label><input id="s-end"></div>
      </div>
      <div style="margin-top:10px"><button id="s-create">创建</button></div>
      <p class="small muted" id="s-nowhint"></p>
    </div>
    <div id="s-list"></div>`;
  $('#s-nowhint').textContent = '当前服务器时间：' + d.server_time;
  const now = new Date();
  $('#s-start').value = new Date(now.getTime()+3600e3).toISOString().slice(0,16);
  $('#s-end').value = new Date(now.getTime()+9*3600e3).toISOString().slice(0,16);
  $('#s-create').onclick = async () => {
    try {
      await api('/api/shifts',{method:'POST',body:{
        name:$('#s-name').value,
        start_at:new Date($('#s-start').value).toISOString(),
        end_at:new Date($('#s-end').value).toISOString()}});
      toast('班次已创建；下一步选择已审核卡片执行冻结','ok'); renderShifts();
    } catch(e){ toast(e.message,'err'); }
  };
  $('#s-list').innerHTML = d.shifts.map(s => `
    <div class="panel" data-sid="${s.id}">
      <h3>🕒 ${esc(s.name)}
        ${s.handed_over ? tag('withdrawn','已交班') : tag('approved','在班')}
      </h3>
      <p class="small muted">${esc(s.start_at)} → ${esc(s.end_at)}
        ${s.handed_over? ' · 交班于 '+esc(s.handed_over_at):''} · 在班条目 ${s.entry_count}</p>
      <p class="small">当班人员：${s.members.map(m=>esc(m.name)+'('+esc(m.role)+')').join('、')||'<span class="muted">无</span>'}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="secondary" data-act="freeze">整班冻结</button>
        <button class="secondary" data-act="supplement">班中增补/换版</button>
        <button data-act="handover" ${s.handed_over?'disabled':''}>办理交班</button>
        <button class="ghost" data-act="diff">冻结 vs 增补差异</button>
        <button class="ghost" data-act="entries">查看条目/确认</button>
      </div>
      <div class="s-detail" style="margin-top:12px"></div>
    </div>`).join('') || '<p class="muted">暂无班次</p>';

  $$('#s-list .panel').forEach(panel => {
    const sid = Number(panel.dataset.sid);
    $$('button', panel).forEach(b => b.onclick = () =>
      shiftAction(sid, b.dataset.act, panel).catch(e=>toast(e.message,'err')));
  });
}
async function shiftAction(sid, act, panel) {
  const box = $('.s-detail', panel);
  if (act==='handover') {
    await api(`/api/shifts/${sid}/handover`,{method:'POST'});
    toast('交班已登记；此后收到的确认标记为“交班后迟到回执”','ok'); renderShifts(); return;
  }
  if (act==='freeze') {
    const cards = (await api('/api/cards')).cards;
    const opts = cards.map(c=>{
      const latest = c.revisions[0];
      return `<label style="display:block;color:var(--text);margin:4px 0">
        <input type="checkbox" style="width:auto" value="${c.id}" ${latest.status==='approved'?'':'disabled'}>
        ${esc(c.title)} ${tag(latest.status, STATUS_CN[latest.status])} 第${latest.rev}版</label>`;
    }).join('');
    box.innerHTML = `<div class="rev"><b>整班冻结清单</b>（冻结后只可增补，不可修改冻结项；只有已审核卡片可选）
      ${opts}<button id="do-freeze">确认冻结所选卡片</button></div>`;
    $('#do-freeze', box).onclick = async () => {
      const ids = $$('input:checked', box).map(i=>Number(i.value));
      try {
        const r = await api(`/api/shifts/${sid}/freeze`,{method:'POST',body:{card_ids:ids}});
        toast(`已冻结 ${r.frozen.length} 项，绑定具体修订版本`,'ok'); renderShifts();
      } catch(e){ toast(e.message,'err'); }
    };
    return;
  }
  if (act==='supplement') {
    const cards = (await api('/api/cards')).cards;
    const opts = cards.map(c=>{
      const latest = c.revisions[0];
      return `<label style="display:block;color:var(--text);margin:4px 0">
        <input type="checkbox" style="width:auto" value="${c.id}" ${latest.status==='approved'?'':'disabled'}>
        ${esc(c.title)} — 当前最新：第${latest.rev}版 ${tag(latest.status,STATUS_CN[latest.status])}</label>`;
    }).join('');
    box.innerHTML = `<div class="rev"><b>班中增补紧急卡 / 让新版本生效</b>
      <p class="small muted">新卡直接加入增补清单；已在班卡片如选了更新版本，旧条目标记“已被新版取代”，
      旧确认留在旧版，未确认人员必须确认新版（不自动覆盖）。</p>
      ${opts}<label>增补说明</label><input id="sup-note" value="班中紧急增补">
      <button id="do-sup">执行增补</button></div>`;
    $('#do-sup', box).onclick = async () => {
      const ids = $$('input:checked', box).map(i=>Number(i.value));
      try {
        const r = await api(`/api/shifts/${sid}/supplement`,{method:'POST',
          body:{card_ids:ids, note:$('#sup-note',box).value}});
        const lines = r.changes.map(c =>
          c.kind==='new_card' ? `新紧急卡 card#${c.card_id} → 新条目#${c.entry_id}（待全部确认）`
          : c.kind==='revision_update'
            ? `card#${c.card_id} 第${c.rev}版生效：旧条目#${c.superseded_entry}已取代，新条目#${c.entry_id}待确认，旧确认不迁移`
          : `card#${c.card_id} 已是同版本，无需重复增补`);
        toast('增补完成：\n'+lines.join('\n'),'ok'); renderShifts();
      } catch(e){ toast(e.message,'err'); }
    };
    return;
  }
  if (act==='diff') {
    const d = await api(`/api/shifts/${sid}/diff`);
    const renderEntry = e => `<tr>
      <td>#${e.entry_id}<br><span class="muted small">${esc(e.title)}</span></td>
      <td>第${e.rev}版<br><span class="muted small">${esc(e.content_hash)}</span></td>
      <td>${tag(e.status,STATUS_CN[e.status])}</td>
      <td>${e.list_type==='frozen'?tag('frozen','冻结'):tag('supplement','增补')}</td>
      <td class="small">${esc(e.impact_on_open_confirmations)}
        ${e.pending_persons && e.pending_persons.length?'<br>未确认：'+e.pending_persons.map(esc).join('、'):''}</td></tr>`;
    box.innerHTML = `<div class="rev">
      <b>整班冻结清单 vs 班中增补清单</b>
      <p class="small muted">${esc(d.summary)}</p>
      <table><thead><tr><th>条目</th><th>修订</th><th>状态</th><th>清单</th><th>对未完成确认的影响</th></tr></thead>
      <tbody>${d.frozen_list.map(renderEntry).join('')}${d.supplement_list.map(renderEntry).join('')}</tbody></table>
    </div>`;
    return;
  }
  if (act==='entries') {
    const d = await api(`/api/shifts/${sid}/entries`);
    box.innerHTML = `<div class="rev"><table><thead><tr>
      <th>条目</th><th>清单/状态</th><th>修订绑定</th><th>确认明细（人 → 版本 → 时机）</th></tr></thead><tbody>
      ${d.entries.map(e=>`<tr>
        <td>#${e.id} ${esc(e.revision.title)}<br><span class="muted small">负责人：${esc(e.revision.responsible)||'—'}</span></td>
        <td>${e.list_type==='frozen'?tag('frozen','冻结'):tag('supplement','增补')} ${tag(e.status,STATUS_CN[e.status])}
          ${e.superseded_by_entry?`<br><span class="small muted">被条目#${e.superseded_by_entry}取代</span>`:''}</td>
        <td>card#${e.card_id}<br>第${e.revision.rev}版<br><span class="muted small">${esc(e.revision.content_hash)}</span></td>
        <td>${(e.confirmations||[]).map(c=>`${esc(c.person_name)} → 第${e.revision.rev}版
          ${c.timing==='ON_TIME'?tag('ontime','按时'):tag('late',TIMING_CN[c.timing])}
          <span class="muted small">${esc(c.confirmed_at)}${c.created_via==='offline_queue'?' (离线补传)':''}</span>`).join('<br>')
          || '<span class="muted">尚无确认</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
}

// ---------- 台账 ----------
async function renderLedger() {
  const d = await api('/api/shifts');
  const el = $('#tab-ledger');
  el.innerHTML = `<div class="panel"><h3>选择班次查看“谁确认了哪一版”</h3>
    <select id="l-shift">${d.shifts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <div id="l-body" style="margin-top:12px"></div></div>`;
  const load = async () => {
    const sid = $('#l-shift').value;
    const r = await api(`/api/shifts/${sid}/ledger`);
    $('#l-body').innerHTML = `
      <p class="small muted">共 ${r.records.length} 条确认记录。确认绑定具体修订 hash，而非仅完成百分比。</p>
      <table><thead><tr><th>确认时间(服务器)</th><th>人员</th><th>卡片</th><th>确认的版本</th>
      <th>清单</th><th>时机</th><th>时钟误差</th><th>来源</th></tr></thead><tbody>
      ${r.records.map(x=>`<tr>
        <td>${esc(x.confirmed_at)}</td>
        <td>${esc(x.person_name)}<br><span class="muted small">${esc(x.employee_no)}</span></td>
        <td>${esc(x.title)}<br><span class="small muted">条目#${x.entry_id}，当前状态：${STATUS_CN[x.entry_status_now]}</span></td>
        <td>第${x.rev}版<br><span class="muted small">${esc(x.content_hash)}</span><br>
          ${x.revision_status_now!=='approved'?tag('withdrawn','该版现状:'+STATUS_CN[x.revision_status_now]):tag('approved','已审核')}</td>
        <td>${x.list_type==='frozen'?tag('frozen','冻结'):tag('supplement','增补')}</td>
        <td>${x.timing==='ON_TIME'?tag('ontime','按时'):tag('late',TIMING_CN[x.timing])}</td>
        <td>${x.clock_skew_secs==null?'—':(Math.abs(x.clock_skew_secs)>60?tag('late',x.clock_skew_secs+' 秒 ⚠'):esc(x.clock_skew_secs)+' 秒')}</td>
        <td>${x.created_via==='offline_queue'?'离线补传':'在线'}</td></tr>`).join('')}
      </tbody></table>
      <h3 style="margin-top:18px">班次事件链（发布/冻结/增补/交班/撤回）</h3>
      <table><thead><tr><th>时间</th><th>事件</th><th>操作人</th><th>内容</th></tr></thead><tbody>
      ${r.events.map(e=>`<tr><td class="small">${esc(e.at)}</td><td>${esc(e.type)}</td>
        <td>${e.actor??'系统'}</td><td class="small muted">${esc(JSON.stringify(e.payload))}</td></tr>`).join('')}
      </tbody></table>`;
  };
  $('#l-shift').onchange = load;
  if (d.shifts.length) load().catch(e=>toast(e.message,'err'));
}

// ---------- 人员 ----------
async function renderPersons() {
  const d = await api('/api/persons');
  $('#tab-persons').innerHTML = `
    <div class="panel"><h3>人员与 PIN（展示端凭工号+PIN 完成已验证身份确认）</h3>
      <table><thead><tr><th>工号</th><th>姓名</th><th>管理员</th><th>状态</th></tr></thead><tbody>
      ${d.persons.map(p=>`<tr><td>${esc(p.employee_no)}</td><td>${esc(p.name)}</td>
        <td>${p.is_admin?'是':''}</td><td>${p.active?'在职':'停用'}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="panel"><h3>新增人员</h3>
      <div class="row"><div><label>姓名</label><input id="p-name"></div>
      <div><label>工号</label><input id="p-no"></div>
      <div><label>PIN（数字）</label><input id="p-pin"></div></div>
      <label style="display:flex;gap:8px;align-items:center;color:var(--text)">
        <input type="checkbox" id="p-admin" style="width:auto"> 管理员</label>
      <div style="margin-top:8px"><button id="p-add">新增</button></div></div>`;
  $('#p-add').onclick = async () => {
    try {
      await api('/api/persons',{method:'POST',body:{
        name:$('#p-name').value, employee_no:$('#p-no').value.trim(),
        pin:$('#p-pin').value, is_admin:$('#p-admin').checked}});
      toast('已新增','ok'); renderPersons();
    } catch(e){ toast(e.message,'err'); }
  };
}

// ---------- 事件 ----------
async function renderEvents() {
  const d = await api('/api/events');
  $('#tab-events').innerHTML = `<div class="panel"><h3>最近事件</h3>
    <table><thead><tr><th>时间</th><th>类型</th><th>对象</th><th>操作人</th><th>内容</th></tr></thead><tbody>
    ${d.events.map(e=>`<tr><td class="small">${esc(e.at)}</td><td>${esc(e.type)}</td>
    <td>${esc(e.entity||'')}#${e.entity_id??''}</td><td>${e.actor??''}</td>
    <td class="small muted">${esc(JSON.stringify(e.payload))}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------- 启动 ----------
$('#li-btn').onclick = login;
$('#li-pin').addEventListener('keydown', e => e.key==='Enter' && login());
$('#logout').onclick = logout;
(async function bootstrap(){
  if (!TOKEN) return;
  try {
    const d = await api('/api/auth/me');
    if (!d.person.is_admin) throw new Error('非管理员');
    ME = d.person; showApp();
  } catch(e) { logout(); }
})();
