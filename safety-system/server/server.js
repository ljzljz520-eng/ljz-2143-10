// 车间安全提示展示系统 —— 服务 API
// 所有发布 / 交接 / 确认均落库并写审计；确认绑定 卡片修订 + 班次 + 已验证人员。
const path = require('path');
const fs = require('fs');
const express = require('express');
const { load, mutate, uid, sha256, nowIso, nowTs, audit } = require('./db');
const D = require('./domain');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const SESSION_TTL = 12 * 3600 * 1000;
const sessions = new Map(); // token -> { type:'person'|'admin', id, exp }

function issueSession(type, id) {
  const token = uid('tok');
  sessions.set(token, { type, id, exp: nowTs() + SESSION_TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < nowTs()) { sessions.delete(token); return null; }
  return s;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function requirePerson(req, res, next) {
  const s = getSession(bearer(req));
  if (!s || s.type !== 'person') return res.status(401).json({ error: '需要已验证人员身份（请输入工号与PIN）' });
  const person = load().persons.find(p => p.id === s.id && p.active);
  if (!person) return res.status(401).json({ error: '人员不存在或已停用' });
  req.person = person;
  next();
}
function requireAdmin(req, res, next) {
  const s = getSession(bearer(req));
  if (!s || s.type !== 'admin') return res.status(401).json({ error: '需要管理员登录' });
  const admin = load().admins.find(a => a.id === s.id);
  if (!admin) return res.status(401).json({ error: '管理员不存在' });
  req.admin = admin;
  next();
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------- 认证 ----------------
app.post('/api/auth/person', wrap((req, res) => {
  const { employee_id, pin } = req.body || {};
  const db = load();
  const p = db.persons.find(x => x.id === String(employee_id || '').trim());
  if (!p || !p.active || !pin || p.pin_hash !== sha256(String(pin))) {
    audit(db, { actor_type: 'person', actor_id: employee_id || null, action: 'auth.fail',
      detail: { via: 'c-terminal' } });
    mutate(() => {}); // 落审计
    return res.status(401).json({ error: '工号或PIN不正确；仍可查看提示，但无法完成确认' });
  }
  const token = issueSession('person', p.id);
  mutate(d => audit(d, { actor_type: 'person', actor_id: p.id, action: 'auth.ok', detail: { via: 'c-terminal' } }));
  res.json({ token, person: { id: p.id, name: p.name, role: p.role } });
}));

app.post('/api/auth/admin', wrap((req, res) => {
  const { username, password } = req.body || {};
  const db = load();
  const a = db.admins.find(x => x.username === String(username || '').trim());
  if (!a || !password || a.password_hash !== sha256(String(password))) {
    mutate(d => audit(d, { actor_type: 'admin', actor_id: username || null, action: 'auth.fail', detail: { via: 'web-admin' } }));
    return res.status(401).json({ error: '用户名或密码不正确' });
  }
  const token = issueSession('admin', a.id);
  mutate(d => audit(d, { actor_type: 'admin', actor_id: a.id, action: 'auth.ok', detail: { via: 'web-admin' } }));
  res.json({ token, admin: { id: a.id, username: a.username, name: a.name } });
}));

app.get('/api/auth/me', wrap((req, res) => {
  const s = getSession(bearer(req));
  if (!s) return res.status(401).json({ error: '未登录' });
  if (s.type === 'admin') {
    const a = load().admins.find(x => x.id === s.id);
    return res.json({ type: 'admin', admin: a ? { id: a.id, username: a.username, name: a.name } : null });
  }
  const p = load().persons.find(x => x.id === s.id);
  res.json({ type: 'person', person: p ? { id: p.id, name: p.name, role: p.role } : null });
}));

app.post('/api/auth/logout', wrap((req, res) => {
  const t = bearer(req);
  if (t) sessions.delete(t);
  res.json({ ok: true });
}));

// ---------------- 展示端（C 窗口） ----------------
app.get('/api/time', (req, res) => {
  res.json({ server_ts: nowTs(), server_iso: nowIso() });
});

function personMap(db) { return Object.fromEntries(db.persons.map(p => [p.id, p])); }

function boardShift(db, shiftId) {
  if (shiftId) {
    const s = db.shifts.find(x => x.id === shiftId);
    if (s) return s;
  }
  const actives = db.shifts.filter(s => s.status === 'active')
    .sort((a, b) => b.started_ts - a.started_ts);
  return actives[0] || null;
}

function boardPayload(db, shift) {
  const pmap = personMap(db);
  if (!shift) return { server_ts: nowTs(), server_iso: nowIso(), shift: null };
  const scs = db.shift_cards
    .filter(sc => sc.shift_id === shift.id)
    .sort((a, b) => {
      const rank = { frozen: 0, supplement: 1, revision: 2 };
      return (rank[a.source] ?? 9) - (rank[b.source] ?? 9) || a.added_at.localeCompare(b.added_at);
    });
  const cards = scs.map(sc => {
    const rev = db.card_revisions.find(r => r.card_id === sc.card_id && r.revision === sc.revision);
    const rows = db.confirmations.filter(c => c.shift_card_id === sc.id);
    const members = db.memberships.filter(m => m.shift_id === shift.id &&
      (!m.left_at || (m.joined_at <= sc.added_at)));
    return {
      shift_card_id: sc.id,
      card_id: sc.card_id,
      revision: sc.revision,
      source: sc.source, // frozen=整班冻结 | supplement=班中增补 | revision=班中换版
      status: sc.status, // active | superseded | withdrawn
      added_at: sc.added_at,
      withdrawn_at: sc.withdrawn_at || null,
      carried: !!sc.carried,
      title: rev ? rev.title : '(已失效内容)',
      body: rev ? rev.body : '',
      hazard: rev ? rev.hazard : '',
      image_url: rev ? rev.image_url : null,
      tags: rev ? rev.tags : [],
      change_note: rev ? rev.change_note : '',
      owner: rev && pmap[rev.owner_person_id]
        ? { id: rev.owner_person_id, name: pmap[rev.owner_person_id].name, role: pmap[rev.owner_person_id].role }
        : null,
      progress: {
        total: rows.length,
        done: rows.filter(r => r.status === 'confirmed' || r.status === 'confirmed_late').length,
      },
      confirmations: rows.map(r => ({
        person_id: r.person_id,
        person_name: pmap[r.person_id] ? pmap[r.person_id].name : r.person_id,
        status: r.status,
        confirmed_at: r.confirmed_at,
        late: r.late,
        clock_skew_ms: r.clock_skew_ms,
        reason: r.reason,
      })),
    };
  });
  const memberIds = [...new Set(db.memberships.filter(m => m.shift_id === shift.id).map(m => m.person_id))];
  return {
    server_ts: nowTs(),
    server_iso: nowIso(),
    shift: {
      id: shift.id, name: shift.name, code: shift.code, status: shift.status,
      planned_start: shift.planned_start, planned_end: shift.planned_end,
      started_at: shift.started_at, closed_at: shift.closed_at || null,
    },
    members: memberIds.map(id => ({ id, name: pmap[id] ? pmap[id].name : id, role: pmap[id] ? pmap[id].role : '' })),
    cards,
    lists_summary: {
      frozen: cards.filter(c => c.source === 'frozen' && c.status !== 'withdrawn').length,
      supplement: cards.filter(c => c.source === 'supplement').length,
      revision: cards.filter(c => c.source === 'revision' && c.status === 'active').length,
      withdrawn: cards.filter(c => c.status === 'withdrawn').length,
      superseded: cards.filter(c => c.status === 'superseded').length,
      carried: cards.filter(c => c.carried).length,
    },
  };
}

// 看板数据（无需登录即可查看——无法验证身份时允许查看）
app.get('/api/board', wrap((req, res) => {
  const db = load();
  res.json(boardPayload(db, boardShift(db, req.query.shiftId)));
}));

// 当前登录人员的迟到回执清单（跨已交班班次）
app.get('/api/my/catchup', requirePerson, wrap((req, res) => {
  const db = load();
  const rows = db.confirmations.filter(c => c.person_id === req.person.id && c.status === 'carried');
  const out = rows.map(c => {
    const sc = db.shift_cards.find(s => s.id === c.shift_card_id);
    const shift = db.shifts.find(s => s.id === c.shift_id);
    const rev = db.card_revisions.find(r => r.card_id === c.card_id && r.revision === c.revision);
    return {
      shift_card_id: c.shift_card_id, shift_id: c.shift_id,
      shift_name: shift ? shift.name : c.shift_id,
      card_id: c.card_id, revision: c.revision,
      title: rev ? rev.title : '(已失效)', hazard: rev ? rev.hazard : '',
      body: rev ? rev.body : '', source: sc ? sc.source : null,
      closed_at: shift ? shift.closed_at : null,
    };
  });
  res.json({ items: out });
}));

// 人员确认：绑定 修订 + 班次 + 已验证人员
app.post('/api/confirmations', requirePerson, wrap((req, res) => {
  const { shift_card_id, client_clock_ms } = req.body || {};
  const result = mutate(db => {
    const sc = db.shift_cards.find(s => s.id === shift_card_id);
    if (!sc) throw D.httpError(404, '卡片条目不存在');
    const shift = db.shifts.find(s => s.id === sc.shift_id);
    const member = db.memberships.find(m => m.shift_id === shift.id && m.person_id === req.person.id);
    if (!member) throw D.httpError(403, '您不是该班次成员，不能确认本班卡片');
    const cnf = db.confirmations.find(c => c.shift_card_id === sc.id && c.person_id === req.person.id);
    if (!cnf) throw D.httpError(409, '没有对应的待确认记录');

    // 旧版/撤回卡禁止确认——旧卡确认不能覆盖新风险
    if (cnf.status === 'superseded' || sc.status === 'superseded')
      throw D.httpError(409, '该修订已被新版取代，请确认当前新版本（旧版确认不能覆盖新风险）');
    if (cnf.status === 'withdrawn' || sc.status === 'withdrawn')
      throw D.httpError(409, '该卡片已被管理员撤回，不能确认；如需恢复请联系管理员');
    if (cnf.status === 'confirmed' || cnf.status === 'confirmed_late')
      return { duplicate: true, confirmation: cnf };

    const srv = nowTs();
    const skew = Number.isFinite(client_clock_ms) ? srv - Number(client_clock_ms) : null;
    const isLate = shift.status === 'closed';
    cnf.status = isLate ? 'confirmed_late' : 'confirmed';
    cnf.late = isLate ? 1 : 0;
    cnf.confirmed_at = new Date(srv).toISOString(); // 以服务端时钟为准
    cnf.client_clock = Number.isFinite(client_clock_ms) ? Number(client_clock_ms) : null;
    cnf.clock_skew_ms = skew;
    audit(db, { actor_type: 'person', actor_id: req.person.id, shift_id: shift.id,
      action: 'confirmation.create',
      detail: { shift_card_id: sc.id, card_id: sc.card_id, revision: sc.revision,
        late: cnf.late, clock_skew_ms: skew } });
    return { duplicate: false, confirmation: cnf };
  });
  res.status(result.duplicate ? 200 : 201).json({
    ok: true, duplicate: result.duplicate,
    status: result.confirmation.status,
    revision: result.confirmation.revision,
    confirmed_at: result.confirmation.confirmed_at,
    late: !!result.confirmation.late,
    clock_skew_ms: result.confirmation.clock_skew_ms,
    clock_warning: result.confirmation.clock_skew_ms != null && Math.abs(result.confirmation.clock_skew_ms) > 60000,
    notice: result.confirmation.late
      ? '已记录为交班后的迟到回执；仅表示您已知悉该修订内容，不表示风险已消除。'
      : '确认仅表示您已知悉该修订内容，不表示风险已经消除。',
  });
}));

// ---------------- 管理端：人员 ----------------
app.get('/api/admin/persons', requireAdmin, wrap((req, res) => {
  const db = load();
  res.json({ persons: db.persons.map(p => ({ id: p.id, name: p.name, role: p.role, active: p.active, created_at: p.created_at })) });
}));
app.post('/api/admin/persons', requireAdmin, wrap((req, res) => {
  const { name, role, pin, employee_id } = req.body || {};
  if (!name || !pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: '姓名必填，PIN为4-6位数字' });
  const r = mutate(db => {
    const id = String(employee_id || '').trim() || ('p_' + uid('x').slice(2, 8));
    if (db.persons.some(p => p.id === id)) throw D.httpError(409, '工号已存在');
    const p = { id, name, role: role || '操作工', pin_hash: sha256(String(pin)), active: true, created_at: nowTs() };
    db.persons.push(p);
    audit(db, { actor_type: 'admin', actor_id: req.admin.id, action: 'person.create', detail: { id, name } });
    return p;
  });
  res.status(201).json({ person: { id: r.id, name: r.name, role: r.role } });
}));
app.post('/api/admin/persons/:id/reset-pin', requireAdmin, wrap((req, res) => {
  const { pin } = req.body || {};
  if (!/^\d{4,6}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN为4-6位数字' });
  mutate(db => {
    const p = db.persons.find(x => x.id === req.params.id);
    if (!p) throw D.httpError(404, '人员不存在');
    p.pin_hash = sha256(String(pin));
    audit(db, { actor_type: 'admin', actor_id: req.admin.id, action: 'person.reset-pin', detail: { id: p.id } });
  });
  res.json({ ok: true });
}));
app.post('/api/admin/persons/:id/deactivate', requireAdmin, wrap((req, res) => {
  mutate(db => {
    const p = db.persons.find(x => x.id === req.params.id);
    if (!p) throw D.httpError(404, '人员不存在');
    p.active = false;
    audit(db, { actor_type: 'admin', actor_id: req.admin.id, action: 'person.deactivate', detail: { id: p.id } });
  });
  res.json({ ok: true });
}));

// ---------------- 管理端：卡片 ----------------
app.get('/api/admin/cards', requireAdmin, wrap((req, res) => {
  const db = load();
  res.json({ cards: db.cards.map(c => ({
    id: c.id, title: c.title, hazard: c.hazard, current_revision: c.current_revision,
    published: c.published, withdrawn: c.withdrawn, owner_person_id: c.owner_person_id,
    image_url: c.image_url, tags: c.tags, created_at: c.created_at,
  })) });
}));
app.get('/api/admin/cards/:id/revisions', requireAdmin, wrap((req, res) => {
  const db = load();
  res.json({ revisions: db.card_revisions.filter(r => r.card_id === req.params.id)
    .sort((a, b) => b.revision - a.revision) });
}));
app.post('/api/admin/cards', requireAdmin, wrap((req, res) => {
  const { title, body, hazard, owner_person_id, image_url, tags } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: '标题与正文必填' });
  const r = mutate(db => {
    const id = 'card_' + uid('x').slice(2, 10);
    const card = {
      id, title, body, hazard: hazard || '', owner_person_id: owner_person_id || null,
      image_url: image_url || null, tags: tags || [], current_revision: 0,
      published: false, withdrawn: false, created_at: nowTs(), created_by: req.admin.id,
    };
    db.cards.push(card);
    audit(db, { actor_type: 'admin', actor_id: req.admin.id, action: 'card.create', detail: { id, title } });
    return card;
  });
  res.status(201).json({ card: { id: r.id, title: r.title, published: false } });
}));
// 草稿首发
app.post('/api/admin/cards/:id/publish', requireAdmin, wrap((req, res) => {
  const { change_note } = req.body || {};
  const r = mutate(db => {
    const card = db.cards.find(c => c.id === req.params.id);
    if (!card) throw D.httpError(404, '卡片不存在');
    if (card.withdrawn) throw D.httpError(409, '卡片已撤回，请新建卡片');
    if (card.published) throw D.httpError(409, '卡片已发布，修改请使用"发布新版"');
    const revNo = 1;
    const rev = { id: uid('rev'), card_id: card.id, revision: 1,
      title: card.title, body: card.body, hazard: card.hazard,
      owner_person_id: card.owner_person_id, image_url: card.image_url, tags: card.tags,
      published_at: nowTs(), published_by: req.admin.id, change_note: change_note || '初次发布' };
    db.card_revisions.push(rev);
    card.current_revision = 1; card.published = true;
    // 进行中的班次：首发卡片以增补方式进入
    const migrations = [];
    for (const shift of db.shifts.filter(s => s.status === 'active')) {
      const sc = D.supplementCard(db, shift, card.id, { urgent: true }, req.admin.id);
      migrations.push({ shift_id: shift.id, shift_card_id: sc.id, effect: 'supplement', revision: 1 });
    }
    audit(db, { actor_type: 'admin', actor_id: req.admin.id,
      action: 'card.publish', detail: { card_id: card.id, migrations } });
    return { rev, migrations };
  });
  res.status(201).json({ revision: r.rev, migrations: r.migrations });
}));
// 发布新版（修订）：进行中班次旧版挂起项迁移，全员重认新版
app.post('/api/admin/cards/:id/revise', requireAdmin, wrap((req, res) => {
  const { title, body, hazard, owner_person_id, image_url, tags, change_note } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: '标题与正文必填' });
  const r = mutate(db => {
    const card = db.cards.find(c => c.id === req.params.id);
    if (!card) throw D.httpError(404, '卡片不存在');
    if (card.withdrawn) throw D.httpError(409, '卡片已撤回');
    if (!card.published) throw D.httpError(409, '草稿请先首发');
    const revNo = card.current_revision + 1;
    const out = D.publishRevision(db, card, revNo,
      { title, body, hazard: hazard || '', owner_person_id: owner_person_id || card.owner_person_id,
        image_url: image_url || null, tags: tags || card.tags, change_note: change_note || '' },
      req.admin.id);
    return out;
  });
  res.status(201).json({ revision: r.rev, migrations: r.migrations });
}));
app.post('/api/admin/cards/:id/withdraw', requireAdmin, wrap((req, res) => {
  const { reason } = req.body || {};
  const effects = mutate(db => D.withdrawCard(db, req.params.id, req.admin.id, reason || ''));
  res.json({ ok: true, effects });
}));

// ---------------- 管理端：班次 ----------------
app.get('/api/admin/shifts', requireAdmin, wrap((req, res) => {
  const db = load();
  const list = db.shifts.map(s => ({
    id: s.id, name: s.name, code: s.code, status: s.status,
    planned_start: s.planned_start, planned_end: s.planned_end,
    started_at: s.started_at, closed_at: s.closed_at,
    member_count: db.memberships.filter(m => m.shift_id === s.id).length,
    card_count: db.shift_cards.filter(sc => sc.shift_id === s.id && sc.status === 'active').length,
    done: db.confirmations.filter(c => c.shift_id === s.id &&
      (c.status === 'confirmed' || c.status === 'confirmed_late')).length,
    total: db.confirmations.filter(c => c.shift_id === s.id).length,
  })).sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  res.json({ shifts: list });
}));
app.get('/api/admin/shifts/:id', requireAdmin, wrap((req, res) => {
  const db = load();
  const s = db.shifts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '班次不存在' });
  res.json({ board: boardPayload(db, s) });
}));
app.post('/api/admin/shifts', requireAdmin, wrap((req, res) => {
  const { name, planned_start, planned_end, person_ids } = req.body || {};
  if (!name) return res.status(400).json({ error: '班次名称必填' });
  const r = mutate(db => {
    const s = {
      id: uid('shift'), name, code: req.body.code || name, status: 'planned',
      planned_start: planned_start || null, planned_end: planned_end || null,
      started_at: null, started_ts: 0, closed_at: null, closed_ts: 0, created_by: req.admin.id,
    };
    db.shifts.push(s);
    for (const pid of person_ids || []) {
      if (db.persons.some(p => p.id === pid && p.active)) {
        db.memberships.push({ id: uid('mem'), shift_id: s.id, person_id: pid, joined_at: null, left_at: null });
      }
    }
    audit(db, { actor_type: 'admin', actor_id: req.admin.id, shift_id: s.id,
      action: 'shift.create', detail: { name, members: (person_ids || []).length } });
    return s;
  });
  res.status(201).json({ shift: { id: r.id, name: r.name, status: r.status } });
}));
app.post('/api/admin/shifts/:id/members', requireAdmin, wrap((req, res) => {
  const { person_id } = req.body || {};
  mutate(db => {
    const shift = db.shifts.find(s => s.id === req.params.id);
    if (!shift) throw D.httpError(404, '班次不存在');
    const p = db.persons.find(x => x.id === person_id && x.active);
    if (!p) throw D.httpError(404, '人员不存在或已停用');
    if (db.memberships.some(m => m.shift_id === shift.id && m.person_id === person_id))
      throw D.httpError(409, '该人员已在本班');
    if (shift.status === 'active') {
      D.joinMember(db, shift, person_id, req.admin.id); // 班中加入：为活动卡补待确认
    } else {
      db.memberships.push({ id: uid('mem'), shift_id: shift.id, person_id, joined_at: null, left_at: null });
      audit(db, { actor_type: 'admin', actor_id: req.admin.id, shift_id: shift.id,
        action: 'shift.assign', detail: { person_id } });
    }
  });
  res.status(201).json({ ok: true });
}));
// 开班 = 冻结清单
app.post('/api/admin/shifts/:id/activate', requireAdmin, wrap((req, res) => {
  const force = !!(req.body || {}).force;
  const r = mutate(db => {
    const shift = db.shifts.find(s => s.id === req.params.id);
    if (!shift) throw D.httpError(404, '班次不存在');
    if (shift.status !== 'planned') throw D.httpError(409, '班次已开班或已交班');
    const other = db.shifts.find(s => s.status === 'active');
    if (other && !force) throw D.httpError(409, `已有进行中班次「${other.name}」，请先交班或使用 force 强制切换`);
    if (other && force) {
      // 强制切换不关闭旧班，仅冻结新班；看板默认取最新开班
      audit(db, { actor_type: 'admin', actor_id: req.admin.id, shift_id: other.id,
        action: 'shift.parallel-activate', detail: { note: '并行开班（force）' } });
    }
    shift.status = 'active';
    shift.started_at = nowIso();
    shift.started_ts = nowTs();
    for (const m of db.memberships.filter(x => x.shift_id === shift.id && !x.joined_at)) m.joined_at = nowIso();
    const frozen = D.freezeShift(db, shift, req.admin.id);
    return { shift, frozen };
  });
  res.json({ ok: true, shift: { id: r.shift.id, name: r.shift.name, status: r.shift.status }, frozen: r.frozen });
}));
// 班中增补紧急卡
app.post('/api/admin/shifts/:id/supplement', requireAdmin, wrap((req, res) => {
  const { card_id, urgent } = req.body || {};
  const sc = mutate(db => {
    const shift = db.shifts.find(s => s.id === req.params.id);
    if (!shift) throw D.httpError(404, '班次不存在');
    if (shift.status !== 'active') throw D.httpError(409, '仅进行中的班次可增补紧急卡');
    return D.supplementCard(db, shift, card_id, { urgent: !!urgent }, req.admin.id);
  });
  const db = load();
  const pend = db.confirmations.filter(c => c.shift_card_id === sc.id).length;
  res.status(201).json({ ok: true, shift_card: { id: sc.id, revision: sc.revision }, pending_created: pend,
    impact: `新增紧急卡 v${sc.revision}：为当班 ${pend} 人新建待确认；不影响其它卡片已有确认。` });
}));
// 交班：未完成项结转
app.post('/api/admin/shifts/:id/handover', requireAdmin, wrap((req, res) => {
  const { note } = req.body || {};
  const h = mutate(db => {
    const shift = db.shifts.find(s => s.id === req.params.id);
    if (!shift) throw D.httpError(404, '班次不存在');
    if (shift.status !== 'active') throw D.httpError(409, '班次不在进行中');
    return D.handover(db, shift, req.admin.id, note || '');
  });
  res.json({ ok: true, handover: h,
    impact: `${h.carried_pending} 条未完成确认已结转为迟到回执，可在下一班或交班后补确认。` });
}));

// ---------------- 追溯：谁确认了哪一版 ----------------
app.get('/api/admin/traces', requireAdmin, wrap((req, res) => {
  const db = load();
  const { shift_id, card_id, person_id } = req.query;
  let rows = db.confirmations.slice();
  if (shift_id) rows = rows.filter(c => c.shift_id === shift_id);
  if (card_id) rows = rows.filter(c => c.card_id === card_id);
  if (person_id) rows = rows.filter(c => c.person_id === person_id);
  const pmap = personMap(db);
  const out = rows.map(c => {
    const shift = db.shifts.find(s => s.id === c.shift_id);
    const sc = db.shift_cards.find(s => s.id === c.shift_card_id);
    const rev = db.card_revisions.find(r => r.card_id === c.card_id && r.revision === c.revision);
    return {
      confirmation_id: c.id,
      shift: shift ? { id: shift.id, name: shift.name, status: shift.status } : null,
      card_id: c.card_id,
      card_title: rev ? rev.title : c.card_id,
      revision: c.revision,
      source: sc ? sc.source : null,
      person: { id: c.person_id, name: pmap[c.person_id] ? pmap[c.person_id].name : c.person_id },
      status: c.status,
      confirmed_at: c.confirmed_at,
      late: c.late,
      created_at: c.created_at,
      reason: c.reason,
      client_clock: c.client_clock,
      clock_skew_ms: c.clock_skew_ms,
    };
  }).sort((a, b) => (b.confirmed_at || b.created_at).localeCompare(a.confirmed_at || a.created_at));
  res.json({ confirmations: out });
}));
app.get('/api/admin/audit', requireAdmin, wrap((req, res) => {
  const db = load();
  let logs = db.audit_logs.slice();
  if (req.query.shift_id) logs = logs.filter(l => l.shift_id === req.query.shift_id);
  res.json({ logs: logs.sort((a, b) => b.at_ts - a.at_ts).slice(0, 500) });
}));

// 摘要说明：冻结清单 vs 增补清单
app.get('/api/admin/shifts/:id/migration-report', requireAdmin, wrap((req, res) => {
  const db = load();
  const b = boardPayload(db, db.shifts.find(s => s.id === req.params.id));
  res.json({ report: b.lists_summary, cards: b.cards.map(c => ({
    card_id: c.card_id, title: c.title, revision: c.revision, source: c.source,
    status: c.status, carried: c.carried, progress: c.progress, added_at: c.added_at,
  })) });
}));

// 健康检查 & 错误处理
app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowTs() }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`安全提示展示系统运行于 http://localhost:${PORT}  (C窗口 /c/  管理端 /admin/)`));
