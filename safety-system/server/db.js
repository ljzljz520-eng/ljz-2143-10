// 数据层：JSON 文件持久化（原子写入），接口风格接近关系库
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PIN_SALT = 'workshop-safety-demo-salt';

function sha256(text) {
  return crypto.createHash('sha256').update(PIN_SALT + ':' + text).digest('hex');
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function nowIso() { return new Date().toISOString(); }
function nowTs() { return Date.now(); }

// ---------- 种子数据 ----------
function seed() {
  const t = nowTs();
  const persons = [
    { id: 'p_wang',  name: '王建国', pin_hash: sha256('123456'), role: '班长',   active: true,  created_at: t },
    { id: 'p_li',    name: '李梅',   pin_hash: sha256('234567'), role: '操作工', active: true,  created_at: t },
    { id: 'p_zhao',  name: '赵强',   pin_hash: sha256('345678'), role: '维修工', active: true,  created_at: t },
    { id: 'p_sun',   name: '孙丽',   pin_hash: sha256('456789'), role: '操作工', active: true,  created_at: t },
  ];
  const mk = (id, title, body, hazard, owner, image, tags) => ({
    id,
    title, body, hazard, owner_person_id: owner, image_url: image, tags: tags || [],
    current_revision: 1, published: true, withdrawn: false,
    created_at: t, created_by: 'admin',
  });
  const cards = [
    mk('card_crane',  '行车下方严禁站人', '吊装作业半径内设置警戒线，任何人不得在吊物下方停留或通行。起吊前由起重指挥确认警戒到位。', '物体打击 / 起重伤害', 'p_wang', '/assets/card-crane.svg'),
    mk('card_lock',   '检修上锁挂牌 LOTO', '3号冲压线检修前必须切断电源、气源并挂牌上锁，钥匙由检修负责人保管，试运行前逐人确认撤离。', '机械伤害 / 触电', 'p_zhao', '/assets/card-lock.svg'),
    mk('card_fire',   '焊接动火作业许可', '焊接区10米内清除可燃物，配备灭火器并设监火人；作业完毕留守观察不少于30分钟。', '火灾 / 灼烫', 'p_li', '/assets/card-fire.svg'),
    mk('card_noise', '高噪声区佩戴耳塞', '空压机房及打磨工位噪声超过85dB(A)，进入前佩戴耳塞，连续暴露不超过2小时/班。', '噪声聋', 'p_sun', null, ['PPE']),
  ];
  const card_revisions = [];
  for (const c of cards) {
    card_revisions.push({
      id: uid('rev'), card_id: c.id, revision: 1,
      title: c.title, body: c.body, hazard: c.hazard,
      owner_person_id: c.owner_person_id, image_url: c.image_url, tags: c.tags,
      published_at: t, published_by: 'admin', change_note: '初次发布',
    });
  }
  return {
    meta: { created_at: t, version: 1 },
    persons,
    admins: [{ id: 'admin', username: 'admin', password_hash: sha256('admin123'), name: '系统管理员', created_at: t }],
    cards,
    card_revisions,
    shifts: [],
    shift_cards: [],
    memberships: [],
    confirmations: [],
    handovers: [],
    audit_logs: [],
  };
}

// ---------- 载入 / 保存 ----------
let data = null;
let saveTimer = null;

function load() {
  if (data) return data;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const backup = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      data = seed();
      data.meta.recovered_from = backup;
      flush();
    }
  } else {
    data = seed();
    flush();
  }
  return data;
}

function flush() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE); // 原子替换
}

// 合并写入：单次同步操作内的数据变更一次性落盘
function mutate(fn) {
  load();
  const r = fn(data);
  flush();
  return r;
}

// ---------- 审计 ----------
function audit(db, entry) {
  db.audit_logs.push({
    id: uid('log'), at: nowIso(), at_ts: nowTs(),
    actor_type: entry.actor_type || 'system',
    actor_id: entry.actor_id || null,
    shift_id: entry.shift_id || null,
    action: entry.action,
    detail: entry.detail || {},
  });
}

module.exports = { load, mutate, flush, audit, uid, sha256, nowIso, nowTs };
