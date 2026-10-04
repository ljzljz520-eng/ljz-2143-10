// 领域逻辑：班次卡片清单的状态迁移
//
// 清单对比与状态迁移规则（核心需求）：
//  1) 整班冻结清单 = 开班时把当时已发布卡片快照进班（source='frozen'），修订版本固定；
//  2) 班中增补清单 = 开班后新增/修订进入本班的卡（source='supplement'/'revision'）；
//  3) 新增紧急卡：直接插入本班，为全体在岗成员生成"待确认"，不影响其它卡已有确认；
//  4) 卡片出新版：旧版未确认项迁移为 superseded 并为新版生成新待确认；
//     —— 已确认旧版的人也必须确认新版（旧卡确认不能覆盖新风险）；
//  5) 管理员撤回：未确认项迁移为 withdrawn，禁止再确认；历史确认保留可追溯；
//  6) 交班：未完成项 carried 结转到下一班视图，可补做迟到回执（confirmed_late）。
const { uid, nowIso, nowTs, audit } = require('./db');

function activeCardRev(db, cardId, atRev) {
  const card = db.cards.find(c => c.id === cardId);
  if (!card) return null;
  const rev = atRev
    ? db.card_revisions.find(r => r.card_id === cardId && r.revision === atRev)
    : db.card_revisions.find(r => r.card_id === cardId && r.revision === card.current_revision);
  return rev || null;
}

function activeMembers(db, shiftId) {
  return db.memberships.filter(m => m.shift_id === shiftId && m.left_at == null);
}

function makePending(db, shiftCard, memberIds, reason) {
  for (const pid of memberIds) {
    db.confirmations.push({
      id: uid('cnf'),
      shift_id: shiftCard.shift_id,
      shift_card_id: shiftCard.id,
      card_id: shiftCard.card_id,
      revision: shiftCard.revision,
      person_id: pid,
      status: 'pending',
      reason,
      created_at: nowIso(),
      confirmed_at: null,
      late: 0,
      client_clock: null,
      clock_skew_ms: null,
    });
  }
}

function cascadePending(db, shiftCardId, status) {
  let n = 0;
  for (const c of db.confirmations) {
    if (c.shift_card_id === shiftCardId && (c.status === 'pending' || c.status === 'carried')) {
      c.status = status; n++;
    }
  }
  return n;
}

function shiftCardProgress(db, sc) {
  const rows = db.confirmations.filter(c => c.shift_card_id === sc.id);
  const done = rows.filter(c => c.status === 'confirmed' || c.status === 'confirmed_late').length;
  return { total: rows.length, done };
}

// 开班冻结：快照当前全部已发布、未撤回卡片
function freezeShift(db, shift, actor) {
  const memberIds = activeMembers(db, shift.id).map(m => m.person_id);
  const pub = db.cards.filter(c => c.published && !c.withdrawn);
  const out = [];
  for (const card of pub) {
    const rev = activeCardRev(db, card.id);
    const sc = {
      id: uid('sc'), shift_id: shift.id, card_id: card.id, revision: rev.revision,
      source: 'frozen', status: 'active', added_at: nowIso(),
      withdrawn_at: null, superseded_by: null, carried: 0,
    };
    db.shift_cards.push(sc);
    makePending(db, sc, memberIds, 'freeze');
    out.push({ card_id: card.id, revision: rev.revision });
  }
  audit(db, { actor_type: 'admin', actor_id: actor, shift_id: shift.id,
    action: 'shift.freeze', detail: { frozen: out, member_count: memberIds.length } });
  return out;
}

// 班中增补紧急卡（新卡或已有卡指定版本）
function supplementCard(db, shift, cardId, opts = {}, actor) {
  const card = db.cards.find(c => c.id === cardId);
  if (!card) throw httpError(404, '卡片不存在');
  if (card.withdrawn) throw httpError(409, '该卡已撤回，不能增补');
  const rev = activeCardRev(db, cardId, opts.revision);
  if (!rev) throw httpError(404, '指定修订不存在');
  const exists = db.shift_cards.find(sc =>
    sc.shift_id === shift.id && sc.card_id === cardId && sc.status === 'active');
  if (exists) throw httpError(409, '该卡已在本班清单中（同一时间仅接受一个活动版本）');

  const sc = {
    id: uid('sc'), shift_id: shift.id, card_id: cardId, revision: rev.revision,
    source: 'supplement', status: 'active', added_at: nowIso(),
    withdrawn_at: null, superseded_by: null, carried: 0,
  };
  db.shift_cards.push(sc);
  const memberIds = activeMembers(db, shift.id).map(m => m.person_id);
  makePending(db, sc, memberIds, 'supplement');
  audit(db, { actor_type: 'admin', actor_id: actor, shift_id: shift.id,
    action: 'shift.supplement', detail: { card_id: cardId, revision: rev.revision, urgent: !!opts.urgent } });
  return sc;
}

// 卡片发布新版：级联迁移所有进行中班次的旧版未确认项
function publishRevision(db, card, revNo, snapshot, actor) {
  const rev = {
    id: uid('rev'), card_id: card.id, revision: revNo,
    title: snapshot.title, body: snapshot.body, hazard: snapshot.hazard,
    owner_person_id: snapshot.owner_person_id, image_url: snapshot.image_url || null,
    tags: snapshot.tags || [],
    published_at: nowTs(), published_by: actor, change_note: snapshot.change_note || '',
  };
  db.card_revisions.push(rev);
  card.title = rev.title; card.body = rev.body; card.hazard = rev.hazard;
  card.owner_person_id = rev.owner_person_id; card.image_url = rev.image_url; card.tags = rev.tags;
  card.current_revision = revNo; card.published = true;

  const migrations = [];
  const openShifts = db.shifts.filter(s => s.status === 'active');
  for (const shift of openShifts) {
    const old = db.shift_cards.find(sc =>
      sc.shift_id === shift.id && sc.card_id === card.id && sc.status === 'active');
    const memberIds = activeMembers(db, shift.id).map(m => m.person_id);
    if (!old) {
      // 本班原本没有这张卡：视为增补进入
      const sc = {
        id: uid('sc'), shift_id: shift.id, card_id: card.id, revision: revNo,
        source: 'revision', status: 'active', added_at: nowIso(),
        withdrawn_at: null, superseded_by: null, carried: 0,
      };
      db.shift_cards.push(sc);
      makePending(db, sc, memberIds, 'revision-new');
      migrations.push({ shift_id: shift.id, effect: 'added', revision: revNo });
      continue;
    }
    // 状态迁移：旧版挂起项 superseded，新版全体重新确认（含已确认旧版者）
    const moved = cascadePending(db, old.id, 'superseded');
    old.status = 'superseded';
    old.superseded_at = nowIso();
    const sc = {
      id: uid('sc'), shift_id: shift.id, card_id: card.id, revision: revNo,
      source: 'revision', status: 'active', added_at: nowIso(),
      withdrawn_at: null, superseded_by: null, carried: 0,
    };
    db.shift_cards.push(sc);
    makePending(db, sc, memberIds, 'revision');
    migrations.push({ shift_id: shift.id, effect: 'migrated', old_revision: old.revision,
      new_revision: revNo, pending_moved: moved, member_count: memberIds.length });
  }
  audit(db, { actor_type: 'admin', actor_id: actor,
    action: 'card.revise', detail: { card_id: card.id, revision: revNo, migrations } });
  return { rev, migrations };
}

// 管理员撤回卡片
function withdrawCard(db, cardId, actor, reason) {
  const card = db.cards.find(c => c.id === cardId);
  if (!card) throw httpError(404, '卡片不存在');
  card.withdrawn = true;
  const effects = [];
  for (const sc of db.shift_cards.filter(s => s.card_id === cardId && s.status === 'active')) {
    const moved = cascadePending(db, sc.id, 'withdrawn');
    sc.status = 'withdrawn';
    sc.withdrawn_at = nowIso();
    effects.push({ shift_id: sc.shift_id, revision: sc.revision, pending_moved: moved });
  }
  audit(db, { actor_type: 'admin', actor_id: actor,
    action: 'card.withdraw', detail: { card_id: cardId, reason, effects } });
  return effects;
}

// 班中加入成员：为所有活动卡补建待确认
function joinMember(db, shift, personId, actor) {
  const m = {
    id: uid('mem'), shift_id: shift.id, person_id: personId,
    joined_at: nowIso(), left_at: null,
  };
  db.memberships.push(m);
  const added = [];
  for (const sc of db.shift_cards.filter(s => s.shift_id === shift.id && s.status === 'active')) {
    const exists = db.confirmations.find(c => c.shift_card_id === sc.id && c.person_id === personId);
    if (!exists) {
      makePending(db, sc, [personId], 'member-join');
      added.push(sc.id);
    }
  }
  audit(db, { actor_type: 'admin', actor_id: actor || personId, shift_id: shift.id,
    action: 'shift.join', detail: { person_id: personId, pending_created: added.length } });
  return m;
}

// 交班：未完成确认 carried 结转；已完成的不动
function handover(db, shift, actor, note) {
  const scs = db.shift_cards.filter(s => s.shift_id === shift.id);
  let carried = 0;
  for (const sc of scs) {
    const p = shiftCardProgress(db, sc);
    if (sc.status === 'active' && p.done < p.total) {
      cascadePending(db, sc.id, 'carried');
      sc.carried = 1;
      carried += p.total - p.done;
    }
  }
  shift.status = 'closed';
  shift.closed_at = nowIso();
  shift.closed_ts = nowTs();
  const h = {
    id: uid('ho'), shift_id: shift.id, closed_by: actor, note: note || '',
    carried_pending: carried, at: nowIso(),
  };
  db.handovers.push(h);
  audit(db, { actor_type: 'admin', actor_id: actor, shift_id: shift.id,
    action: 'shift.handover', detail: { carried_pending: carried, note: note || '' } });
  return h;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = {
  activeCardRev, activeMembers, makePending, cascadePending, shiftCardProgress,
  freezeShift, supplementCard, publishRevision, withdrawCard, joinMember, handover, httpError,
};
