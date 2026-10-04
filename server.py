#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
车间安全提示展示系统 - 服务端
零依赖：Python 标准库 http.server + sqlite3

设计原则：
- 系统只传达经人工审核的提示；确认语义为"知悉确认"，不表示风险消除。
- 确认必须绑定：具体卡片修订(card_revision_id) + 班次(shift_id) + 已验证人员(person_id)。
- 整班冻结清单 vs 班中增补清单分离；增补的紧急卡产生新 entry，旧 entry 保留并 SUPERSEDED，
  旧卡上的未完成确认不会自动覆盖到新风险，必须重新确认新版。
- 撤回卡片不删除历史，相关在班条目进入 WITHDRAWN，旧确认仍可追溯。
- 设备离线由前端缓存兜底；服务端以服务器时钟为权威，记录客户端时钟并标记时钟误差。
"""
import json
import os
import sqlite3
import hashlib
import secrets
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SAFETY_DB", os.path.join(BASE_DIR, "data", "safety.db"))

# 时钟误差判定阈值（秒）：客户端时间与服务器相差超过即标记 clock_skew
CLOCK_SKEW_LIMIT_SEC = 60

# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  employee_no TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  risk_text TEXT NOT NULL,
  measure_text TEXT NOT NULL DEFAULT '',
  responsible TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  created_by INTEGER REFERENCES person(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_revision (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES card(id),
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  risk_text TEXT NOT NULL,
  measure_text TEXT NOT NULL DEFAULT '',
  responsible TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','withdrawn')),
  created_by INTEGER REFERENCES person(id),
  created_at TEXT NOT NULL,
  approved_by INTEGER REFERENCES person(id),
  approved_at TEXT,
  UNIQUE(card_id, rev)
);
CREATE TABLE IF NOT EXISTS shift (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  handed_over INTEGER NOT NULL DEFAULT 0,
  handed_over_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shift_member (
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  role TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(shift_id, person_id)
);
CREATE TABLE IF NOT EXISTS shift_card_entry (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  card_id INTEGER NOT NULL REFERENCES card(id),
  card_revision_id INTEGER NOT NULL REFERENCES card_revision(id),
  list_type TEXT NOT NULL CHECK(list_type IN ('frozen','supplement')),
  status TEXT NOT NULL CHECK(status IN ('pending','superseded','withdrawn','confirmed')),
  added_at TEXT NOT NULL,
  added_by INTEGER REFERENCES person(id),
  superseded_by_entry INTEGER,
  origin_entry INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS confirmation (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES shift_card_entry(id),
  card_revision_id INTEGER NOT NULL REFERENCES card_revision(id),
  shift_id INTEGER NOT NULL REFERENCES shift(id),
  person_id INTEGER NOT NULL REFERENCES person(id),
  confirmed_at TEXT NOT NULL,
  client_clock TEXT,
  clock_skew_secs INTEGER,
  timing TEXT NOT NULL CHECK(timing IN ('ON_TIME','LATE_BEFORE_HANDOVER','LATE_AFTER_HANDOVER')),
  created_via TEXT NOT NULL DEFAULT 'online'
);
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  actor INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id),
  purpose TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
"""

def now_utc():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()

def hash_pin(pin, employee_no):
    return hashlib.sha256((employee_no + ":" + pin).encode()).hexdigest()

def content_hash(rev):
    raw = json.dumps({
        "title": rev["title"],
        "risk_text": rev["risk_text"],
        "measure_text": rev.get("measure_text", ""),
        "responsible": rev.get("responsible", ""),
        "image_url": rev.get("image_url"),
    }, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db(seed=False):
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    if seed:
        run_seed(conn)
    conn.close()

def log_event(conn, etype, entity_type, entity_id, actor, payload=None):
    conn.execute(
        "INSERT INTO event_log(event_type,entity_type,entity_id,actor,payload,created_at) VALUES(?,?,?,?,?,?)",
        (etype, entity_type, entity_id, actor, json.dumps(payload or {}, ensure_ascii=False), now_utc()))

def parse_iso(s):
    if s is None:
        return None
    try:
        s2 = s.replace("Z", "+00:00")
        d = dt.datetime.fromisoformat(s2)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc)
    except Exception:
        return None

# ---------------------------------------------------------------------------
# 种子数据
# ---------------------------------------------------------------------------
def run_seed(conn):
    if conn.execute("SELECT COUNT(*) c FROM person").fetchone()["c"]:
        return
    t = now_utc()
    people = [
        ("管理员", "A001", "1111", 1),
        ("王强", "E001", "2222", 0),
        ("李娜", "E002", "3333", 0),
    ]
    for name, no, pin, adm in people:
        conn.execute(
            "INSERT INTO person(name,employee_no,pin_hash,is_admin,created_at) VALUES(?,?,?,?,?)",
            (name, no, hash_pin(pin, no), adm, t))

    cards = [
        # title, risk, measure, responsible, image_url
        ("高处作业坠落风险", "2号机组检修平台护栏拆除，存在坠落风险。",
         "作业前挂双钩安全带；监护人全程在位；严禁抛物。", "王强",
         "/static/poster.svg"),
        ("受限空间窒息风险", "循环水廊道通风未完成，含氧量可能不足。",
         "先通风、再检测、后作业；气体检测仪随身携带。", "李娜",
         ""),  # 无图：用于图片缺失/解码失败的文字降级验收
        ("吊装区域打击风险", "车间西侧吊装作业，吊物回转半径内禁止站人。",
         "设置警戒区，专人指挥；佩戴安全帽。", "王强",
         "/static/missing-broken.png"),  # 坏图：触发 onerror 降级
    ]
    for title, risk, meas, resp, img in cards:
        cid = conn.execute(
            "INSERT INTO card(title,risk_text,measure_text,responsible,image_url,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            (title, risk, meas, resp, img or None, 1, t)).lastrowid
        row = {"title": title, "risk_text": risk, "measure_text": meas,
               "responsible": resp, "image_url": img or None}
        conn.execute(
            """INSERT INTO card_revision(card_id,rev,title,risk_text,measure_text,responsible,image_url,
               content_hash,status,created_by,created_at,approved_by,approved_at)
               VALUES(?,?,?,?,?,?,?,?, 'approved',1,?,1,?)""",
            (cid, 1, title, risk, meas, resp, img or None, content_hash(row), t, t))
        log_event(conn, "card_revision_approved", "card_revision", cid, 1, {"rev": 1})

    # 班次：固定过去的时间窗口，便于验收"交班后迟到回执"
    start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).replace(microsecond=0)
    end = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).replace(microsecond=0)
    sid = conn.execute(
        "INSERT INTO shift(name,start_at,end_at,handed_over,handed_over_at,created_at) VALUES(?,?,?,1,?,?)",
        ("白班-检修甲班", start.isoformat(), end.isoformat(), end.isoformat(), t)).lastrowid
    conn.execute("INSERT INTO shift_member(shift_id,person_id,role) VALUES(?,?,?)", (sid, 2, "班长"))
    conn.execute("INSERT INTO shift_member(shift_id,person_id,role) VALUES(?,?,?)", (sid, 3, "班员"))

    # 整班冻结清单：两张卡（冻结）
    for cid, note in [(1, "班前会冻结"), (2, "班前会冻结")]:
        rev = conn.execute("SELECT id FROM card_revision WHERE card_id=? AND rev=1", (cid,)).fetchone()
        conn.execute(
            """INSERT INTO shift_card_entry(shift_id,card_id,card_revision_id,list_type,status,added_at,added_by,note)
               VALUES(?,?,?, 'frozen','pending',?,1,?)""",
            (sid, cid, rev["id"], t, note))
    log_event(conn, "shift_frozen", "shift", sid, 1, {"entry_count": 2})
    log_event(conn, "shift_handed_over", "shift", sid, 1, {"at": end.isoformat()})
    conn.commit()

# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, code, message, extra=None):
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}

def row_person(r):
    return {"id": r["id"], "name": r["name"], "employee_no": r["employee_no"],
            "is_admin": bool(r["is_admin"]), "active": bool(r["active"])}

def row_revision(r):
    return {
        "id": r["id"], "card_id": r["card_id"], "rev": r["rev"],
        "title": r["title"], "risk_text": r["risk_text"],
        "measure_text": r["measure_text"], "responsible": r["responsible"],
        "image_url": r["image_url"], "content_hash": r["content_hash"],
        "status": r["status"], "created_at": r["created_at"],
        "approved_at": r["approved_at"],
        "approved_by": r["approved_by"],
    }

def entry_detail(conn, e, include_confirmations=False):
    rev = conn.execute("SELECT * FROM card_revision WHERE id=?", (e["card_revision_id"],)).fetchone()
    out = {
        "id": e["id"], "shift_id": e["shift_id"], "card_id": e["card_id"],
        "card_revision_id": e["card_revision_id"], "list_type": e["list_type"],
        "status": e["status"], "added_at": e["added_at"], "note": e["note"],
        "superseded_by_entry": e["superseded_by_entry"], "origin_entry": e["origin_entry"],
        "revision": row_revision(rev),
    }
    if include_confirmations:
        cs = conn.execute(
            """SELECT c.*, p.name person_name, p.employee_no FROM confirmation c
               JOIN person p ON p.id=c.person_id WHERE c.entry_id=? ORDER BY c.confirmed_at""",
            (e["id"],)).fetchall()
        out["confirmations"] = [
            {"person_id": r["person_id"], "person_name": r["person_name"],
             "employee_no": r["employee_no"], "confirmed_at": r["confirmed_at"],
             "timing": r["timing"], "card_revision_id": r["card_revision_id"],
             "clock_skew_secs": r["clock_skew_secs"], "created_via": r["created_via"]}
            for r in cs]
    return out

class Handler(BaseHTTPRequestHandler):
    server_version = "SafetyDisplay/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默；需要时可打开

    # ---- 基础工具 ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "BAD_JSON", "请求体不是合法 JSON")

    def _token(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        return self.headers.get("X-Auth-Token", "").strip()

    def _session_person(self, conn, purpose=None):
        tok = self._token()
        if not tok:
            raise ApiError(401, "NO_SESSION", "未登录")
        row = conn.execute("SELECT * FROM session WHERE token=?", (tok,)).fetchone()
        if not row:
            raise ApiError(401, "BAD_SESSION", "会话不存在或已退出")
        if parse_iso(row["expires_at"]) < dt.datetime.now(dt.timezone.utc):
            raise ApiError(401, "SESSION_EXPIRED", "会话已过期，请重新验证身份")
        if purpose and row["purpose"] != purpose and row["purpose"] != "admin":
            raise ApiError(403, "WRONG_SCOPE", "会话用途不匹配")
        p = conn.execute("SELECT * FROM person WHERE id=?", (row["person_id"],)).fetchone()
        if not p or not p["active"]:
            raise ApiError(403, "PERSON_INACTIVE", "人员已停用")
        return p

    def _admin(self, conn):
        p = self._session_person(conn, "admin")
        if not p["is_admin"]:
            raise ApiError(403, "FORBIDDEN", "需要管理员权限")
        return p

    # ---- 路由 ----
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        conn = get_db()
        try:
            # 静态资源
            if method == "GET" and (path == "/" or path.startswith("/static/")
                                    or path.startswith("/admin") or path.startswith("/display")):
                return self._serve_static(path)

            rt = ROUTES.get((method, path))
            if rt:
                return rt(self, conn)

            # 带 id 路径: (method, compiled_regex, handler)
            for m_method, pat, handler in DYN_ROUTES:
                if m_method != method:
                    continue
                m = pat.fullmatch(path)
                if m:
                    kw = {k: int(v) if v.isdigit() else v for k, v in m.groupdict().items()}
                    return handler(self, conn, **kw)
            raise ApiError(404, "NOT_FOUND", "接口不存在")
        except ApiError as e:
            self._send_json({"error": e.code, "message": e.message, **e.extra}, e.status)
        except Exception as e:
            conn.rollback()
            self._send_json({"error": "INTERNAL", "message": str(e)}, 500)
        finally:
            conn.close()

    def _serve_static(self, path):
        if path == "/" or path == "/admin" or path == "/admin/":
            path = "/admin/index.html"
        elif path == "/display" or path == "/display/":
            path = "/display/index.html"
        elif path.startswith("/static/"):
            pass
        root = BASE_DIR
        full = os.path.normpath(os.path.join(root, path.lstrip("/")))
        if not full.startswith(root):
            raise ApiError(403, "FORBIDDEN", "非法路径")
        if not os.path.isfile(full):
            # SPA/资源缺失返回 404（前端图片 onerror 依赖浏览器对 <img> 的 404 处理）
            self.send_error(404, "Not Found")
            return
        ctype = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png", ".json": "application/json"}.get(
                     os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # =====================================================================
    # 认证 / 人员
    # =====================================================================
    def api_login(self, conn):
        d = self._read_json()
        no = (d.get("employee_no") or "").strip()
        pin = str(d.get("pin") or "")
        purpose = d.get("purpose", "admin")
        if purpose not in ("admin", "display"):
            raise ApiError(400, "BAD_PURPOSE", "purpose 只能是 admin/display")
        p = conn.execute("SELECT * FROM person WHERE employee_no=?", (no,)).fetchone()
        if not p or hash_pin(pin, no) != p["pin_hash"] or not p["active"]:
            raise ApiError(401, "BAD_CREDENTIALS", "工号或 PIN 错误（未通过身份验证，不能产生确认）")
        tok = secrets.token_hex(24)
        exp = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8 if purpose == "admin" else 2)
        conn.execute("INSERT INTO session(token,person_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)",
                     (tok, p["id"], purpose, now_utc(), exp.replace(microsecond=0).isoformat()))
        log_event(conn, "login", "person", p["id"], p["id"], {"purpose": purpose})
        conn.commit()
        self._send_json({"token": tok, "person": row_person(p)})

    def api_logout(self, conn):
        tok = self._token()
        conn.execute("DELETE FROM session WHERE token=?", (tok,))
        conn.commit()
        self._send_json({"ok": True})

    def api_me(self, conn):
        p = self._session_person(conn)
        self._send_json({"person": row_person(p), "server_time": now_utc()})

    def api_verify_pin(self, conn):
        """展示端在关键动作（确认）前再次验证身份：防止两人共用终端冒用。"""
        base = self._session_person(conn, "display")
        d = self._read_json()
        pin = str(d.get("pin") or "")
        if hash_pin(pin, base["employee_no"]) != base["pin_hash"]:
            raise ApiError(401, "BAD_PIN", "二次验证失败：身份未验证，确认未写入")
        self._send_json({"ok": True, "person": row_person(base), "server_time": now_utc()})

    def api_persons_list(self, conn):
        self._admin(conn)
        rows = conn.execute("SELECT * FROM person ORDER BY id").fetchall()
        self._send_json({"persons": [row_person(r) for r in rows]})

    def api_person_create(self, conn):
        admin = self._admin(conn)
        d = self._read_json()
        name = (d.get("name") or "").strip()
        no = (d.get("employee_no") or "").strip()
        pin = str(d.get("pin") or "")
        if not name or not no or not pin:
            raise ApiError(400, "BAD_FIELD", "姓名/工号/PIN 必填")
        try:
            cur = conn.execute(
                "INSERT INTO person(name,employee_no,pin_hash,is_admin,created_at) VALUES(?,?,?,?,?)",
                (name, no, hash_pin(pin, no), 1 if d.get("is_admin") else 0, now_utc()))
        except sqlite3.IntegrityError:
            raise ApiError(409, "DUP_EMPLOYEE", "工号已存在")
        log_event(conn, "person_created", "person", cur.lastrowid, admin["id"], {"employee_no": no})
        conn.commit()
        self._send_json({"id": cur.lastrowid}, 201)

    # =====================================================================
    # 卡片与修订
    # =====================================================================
    def _require_rev_fields(self, d):
        out = {k: (d.get(k) or "").strip() if k != "image_url" else (d.get("image_url") or None)
               for k in ("title", "risk_text", "measure_text", "responsible")}
        out["image_url"] = d.get("image_url") or None
        if not out["title"]:
            raise ApiError(400, "BAD_FIELD", "卡片标题必填")
        if not out["risk_text"]:
            raise ApiError(400, "BAD_FIELD", "风险提示文字必填（无图时仍须文字可降级展示）")
        return out

    def api_cards_list(self, conn):
        self._session_person(conn)
        rows = conn.execute("SELECT * FROM card ORDER BY id DESC").fetchall()
        result = []
        for c in rows:
            revs = conn.execute("SELECT * FROM card_revision WHERE card_id=? ORDER BY rev DESC",
                                (c["id"],)).fetchall()
            result.append({"id": c["id"], "title": c["title"], "responsible": c["responsible"],
                           "image_url": c["image_url"], "created_at": c["created_at"],
                           "revisions": [row_revision(r) for r in revs]})
        self._send_json({"cards": result})

    def api_card_create(self, conn):
        admin = self._admin(conn)
        d = self._read_json()
        fields = self._require_rev_fields(d)
        t = now_utc()
        cur = conn.execute(
            "INSERT INTO card(title,risk_text,measure_text,responsible,image_url,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            (fields["title"], fields["risk_text"], fields["measure_text"], fields["responsible"],
             fields["image_url"], admin["id"], t))
        cid = cur.lastrowid
        ch = content_hash(fields)
        conn.execute(
            """INSERT INTO card_revision(card_id,rev,title,risk_text,measure_text,responsible,image_url,
               content_hash,status,created_by,created_at) VALUES(?,1,?,?,?,?,?,?, 'draft',?,?)""",
            (cid, fields["title"], fields["risk_text"], fields["measure_text"],
             fields["responsible"], fields["image_url"], ch, admin["id"], t))
        log_event(conn, "card_created", "card", cid, admin["id"], {"title": fields["title"]})
        conn.commit()
        self._send_json({"id": cid}, 201)

    def api_revision_create(self, conn, card_id):
        admin = self._admin(conn)
        card = conn.execute("SELECT * FROM card WHERE id=?", (card_id,)).fetchone()
        if not card:
            raise ApiError(404, "NO_CARD", "卡片不存在")
        d = self._read_json()
        fields = self._require_rev_fields(d)
        last = conn.execute("SELECT MAX(rev) m FROM card_revision WHERE card_id=?", (card_id,)).fetchone()
        newrev = (last["m"] or 0) + 1
        ch = content_hash(fields)
        t = now_utc()
        cur = conn.execute(
            """INSERT INTO card_revision(card_id,rev,title,risk_text,measure_text,responsible,image_url,
               content_hash,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)""",
            (card_id, newrev, fields["title"], fields["risk_text"], fields["measure_text"],
             fields["responsible"], fields["image_url"], ch, admin["id"], t))
        conn.execute("UPDATE card SET title=?,risk_text=?,measure_text=?,responsible=?,image_url=? WHERE id=?",
                     (fields["title"], fields["risk_text"], fields["measure_text"],
                      fields["responsible"], fields["image_url"], card_id))
        log_event(conn, "revision_created", "card_revision", cur.lastrowid, admin["id"],
                  {"card_id": card_id, "rev": newrev})
        conn.commit()
        self._send_json({"id": cur.lastrowid, "rev": newrev, "status": "draft"}, 201)

    def api_revision_approve(self, conn, rev_id):
        """人工审核：只有 approved 的修订才允许发布/冻结到班次（系统不自动审核）。"""
        admin = self._admin(conn)
        rev = conn.execute("SELECT * FROM card_revision WHERE id=?", (rev_id,)).fetchone()
        if not rev:
            raise ApiError(404, "NO_REVISION", "修订不存在")
        if rev["status"] != "draft":
            raise ApiError(409, "NOT_DRAFT", f"修订当前为 {rev['status']}，不能审核")
        conn.execute("UPDATE card_revision SET status='approved',approved_by=?,approved_at=? WHERE id=?",
                     (admin["id"], now_utc(), rev_id))
        log_event(conn, "revision_approved", "card_revision", rev_id, admin["id"],
                  {"card_id": rev["card_id"], "rev": rev["rev"], "content_hash": rev["content_hash"]})
        conn.commit()
        self._send_json({"ok": True})

    def api_card_withdraw(self, conn, card_id):
        """管理员撤回卡片：当前 approved 修订置 withdrawn；在班条目置 WITHDRAWN，历史与确认保留可追溯。"""
        admin = self._admin(conn)
        card = conn.execute("SELECT * FROM card WHERE id=?", (card_id,)).fetchone()
        if not card:
            raise ApiError(404, "NO_CARD", "卡片不存在")
        t = now_utc()
        revs = conn.execute(
            "SELECT * FROM card_revision WHERE card_id=? AND status='approved' ORDER BY rev DESC",
            (card_id,)).fetchall()
        if not revs:
            raise ApiError(409, "NO_APPROVED", "没有已审核修订可撤回")
        rev_ids = [r["id"] for r in revs]
        conn.executemany("UPDATE card_revision SET status='withdrawn' WHERE id=?",
                         [(i,) for i in rev_ids])
        entries = conn.execute(
            "SELECT * FROM shift_card_entry WHERE card_id=? AND status IN ('pending','confirmed')",
            (card_id,)).fetchall()
        affected = []
        for e in entries:
            conn.execute("UPDATE shift_card_entry SET status='withdrawn' WHERE id=?", (e["id"],))
            affected.append(e["id"])
        log_event(conn, "card_withdrawn", "card", card_id, admin["id"],
                  {"revision_ids": rev_ids, "entries_withdrawn": affected})
        conn.commit()
        self._send_json({"ok": True, "entries_withdrawn": affected})

    # =====================================================================
    # 班次
    # =====================================================================
    def _shift_or_404(self, conn, sid):
        s = conn.execute("SELECT * FROM shift WHERE id=?", (sid,)).fetchone()
        if not s:
            raise ApiError(404, "NO_SHIFT", "班次不存在")
        return s

    def _shift_members(self, conn, sid):
        rows = conn.execute(
            """SELECT p.*, sm.role FROM shift_member sm JOIN person p ON p.id=sm.person_id
               WHERE sm.shift_id=? ORDER BY sm.person_id""", (sid,)).fetchall()
        return [{"id": r["id"], "name": r["name"], "employee_no": r["employee_no"],
                 "role": r["role"]} for r in rows]

    def api_shifts_list(self, conn):
        # 允许未验证身份查看班次清单（仅查看）；有有效会话时返回身份信息
        tok = self._token()
        viewer = None
        if tok:
            r0 = conn.execute("SELECT * FROM session WHERE token=?", (tok,)).fetchone()
            if r0 and parse_iso(r0["expires_at"]) > dt.datetime.now(dt.timezone.utc):
                p0 = conn.execute("SELECT * FROM person WHERE id=?", (r0["person_id"],)).fetchone()
                if p0 and p0["active"]:
                    viewer = row_person(p0)
        rows = conn.execute("SELECT * FROM shift ORDER BY start_at DESC").fetchall()
        out = []
        for s in rows:
            n = conn.execute("SELECT COUNT(*) c FROM shift_card_entry WHERE shift_id=? AND status!='withdrawn'",
                             (s["id"],)).fetchone()["c"]
            out.append({"id": s["id"], "name": s["name"], "start_at": s["start_at"],
                        "end_at": s["end_at"], "handed_over": bool(s["handed_over"]),
                        "handed_over_at": s["handed_over_at"], "entry_count": n,
                        "members": self._shift_members(conn, s["id"])})
        self._send_json({"shifts": out, "server_time": now_utc(), "viewer": viewer})

    def api_shift_create(self, conn):
        admin = self._admin(conn)
        d = self._read_json()
        name = (d.get("name") or "").strip()
        st, en = parse_iso(d.get("start_at")), parse_iso(d.get("end_at"))
        if not name or not st or not en:
            raise ApiError(400, "BAD_FIELD", "班次名称、起止时间必填(ISO8601)")
        if en <= st:
            raise ApiError(400, "BAD_TIME", "下班时间必须晚于上班时间")
        members = d.get("member_ids") or []
        cur = conn.execute(
            "INSERT INTO shift(name,start_at,end_at,created_at) VALUES(?,?,?,?)",
            (name, st.isoformat(), en.isoformat(), now_utc()))
        sid = cur.lastrowid
        for pid in members:
            if conn.execute("SELECT 1 FROM person WHERE id=? AND active=1", (pid,)).fetchone():
                conn.execute("INSERT OR IGNORE INTO shift_member(shift_id,person_id,role) VALUES(?,?,?)",
                             (sid, pid, "班员"))
        log_event(conn, "shift_created", "shift", sid, admin["id"], {"name": name})
        conn.commit()
        self._send_json({"id": sid}, 201)

    def api_shift_freeze(self, conn, sid):
        """班前会冻结：从已审核卡片形成整班冻结清单。冻结后只可增补，不可改冻结核。"""
        admin = self._admin(conn)
        s = self._shift_or_404(conn, sid)
        if s["handed_over"]:
            raise ApiError(409, "ALREADY_HANDED_OVER", "班次已交班，不能再冻结")
        if conn.execute("SELECT COUNT(*) c FROM shift_card_entry WHERE shift_id=? AND list_type='frozen'",
                        (sid,)).fetchone()["c"]:
            raise ApiError(409, "ALREADY_FROZEN", "整班清单已冻结，不能重复冻结")
        d = self._read_json()
        card_ids = d.get("card_ids")
        if card_ids is None:
            rows = conn.execute("SELECT id FROM card").fetchall()
            card_ids = [r["id"] for r in rows]
        t = now_utc()
        added = []
        for cid in card_ids:
            rev = conn.execute(
                "SELECT * FROM card_revision WHERE card_id=? AND status='approved' ORDER BY rev DESC LIMIT 1",
                (cid,)).fetchone()
            if not rev:
                raise ApiError(409, "NO_APPROVED_REV", f"卡片 {cid} 没有已审核修订，不能上冻结清单")
            cur = conn.execute(
                """INSERT INTO shift_card_entry(shift_id,card_id,card_revision_id,list_type,status,added_at,added_by,note)
                   VALUES(?,?,?, 'frozen','pending',?,?,'整班冻结清单')""",
                (sid, cid, rev["id"], t, admin["id"]))
            added.append({"entry_id": cur.lastrowid, "card_id": cid, "revision_id": rev["id"],
                          "rev": rev["rev"], "content_hash": rev["content_hash"]})
        log_event(conn, "shift_frozen", "shift", sid, admin["id"], {"entries": added})
        conn.commit()
        self._send_json({"ok": True, "frozen": added})

    def api_shift_handover(self, conn, sid):
        admin = self._admin(conn)
        s = self._shift_or_404(conn, sid)
        if s["handed_over"]:
            raise ApiError(409, "ALREADY_HANDED_OVER", "班次已交班")
        t = now_utc()
        conn.execute("UPDATE shift SET handed_over=1, handed_over_at=? WHERE id=?", (t, sid))
        log_event(conn, "shift_handed_over", "shift", sid, admin["id"], {"at": t})
        conn.commit()
        self._send_json({"ok": True, "handed_over_at": t})

    def api_shift_entries(self, conn, sid):
        self._shift_or_404(conn, sid)
        self._session_person(conn)
        rows = conn.execute("SELECT * FROM shift_card_entry WHERE shift_id=? ORDER BY added_at,id",
                            (sid,)).fetchall()
        self._send_json({"entries": [entry_detail(conn, e, True) for e in rows],
                         "members": self._shift_members(conn, sid)})

    def api_shift_supplement(self, conn, sid):
        """
        班中增补紧急卡：
        - 新卡：直接新增 supplement/pending 条目；
        - 已在班卡片有更新的已审核修订：旧条目置 superseded 并指向新条目，新条目 supplement/pending；
          旧条目上的已有确认保留在旧修订，未确认者必须确认新修订（不迁移、不覆盖）。
        返回受影响条目，驱动展示端状态迁移。
        """
        admin = self._admin(conn)
        s = self._shift_or_404(conn, sid)
        if s["handed_over"]:
            raise ApiError(409, "ALREADY_HANDED_OVER", "班次已交班，不能再增补；请在新班次发布")
        d = self._read_json()
        card_ids = d.get("card_ids") or []
        note = (d.get("note") or "班中紧急增补").strip()
        t = now_utc()
        result = []
        for cid in card_ids:
            rev = conn.execute(
                "SELECT * FROM card_revision WHERE card_id=? AND status='approved' ORDER BY rev DESC LIMIT 1",
                (cid,)).fetchone()
            if not rev:
                raise ApiError(409, "NO_APPROVED_REV", f"卡片 {cid} 没有已审核修订，不能增补")
            existing = conn.execute(
                """SELECT * FROM shift_card_entry WHERE shift_id=? AND card_id=?
                   AND status IN ('pending','confirmed') ORDER BY id DESC LIMIT 1""",
                (sid, cid)).fetchone()
            cur = conn.execute(
                """INSERT INTO shift_card_entry(shift_id,card_id,card_revision_id,list_type,status,added_at,added_by,note,origin_entry)
                   VALUES(?,?,?, 'supplement','pending',?,?,?,?)""",
                (sid, cid, rev["id"], t, admin["id"], note,
                 existing["id"] if existing and existing["card_revision_id"] != rev["id"] else None))
            new_id = cur.lastrowid
            change = {"entry_id": new_id, "card_id": cid, "revision_id": rev["id"],
                      "rev": rev["rev"], "kind": "new_card"}
            if existing:
                if existing["card_revision_id"] == rev["id"]:
                    # 同修订已在班：撤回刚建的重复增补
                    conn.execute("DELETE FROM shift_card_entry WHERE id=?", (new_id,))
                    change = {"entry_id": existing["id"], "card_id": cid,
                              "revision_id": rev["id"], "rev": rev["rev"],
                              "kind": "already_present_same_revision"}
                else:
                    conn.execute(
                        "UPDATE shift_card_entry SET status='superseded', superseded_by_entry=? WHERE id=?",
                        (new_id, existing["id"]))
                    change["kind"] = "revision_update"
                    change["superseded_entry"] = existing["id"]
                    change["old_revision_id"] = existing["card_revision_id"]
                    change["new_revision_id"] = rev["id"]
            result.append(change)
        log_event(conn, "shift_supplemented", "shift", sid, admin["id"], {"changes": result, "note": note})
        conn.commit()
        self._send_json({"ok": True, "changes": result})

    def api_shift_diff(self, conn, sid):
        """比较整班冻结清单与班中增补清单，说明新增紧急卡及对未完成确认的影响。"""
        self._shift_or_404(conn, sid)
        self._session_person(conn)
        frozen = conn.execute(
            "SELECT * FROM shift_card_entry WHERE shift_id=? AND list_type='frozen' ORDER BY id",
            (sid,)).fetchall()
        supp = conn.execute(
            "SELECT * FROM shift_card_entry WHERE shift_id=? AND list_type='supplement' ORDER BY id",
            (sid,)).fetchall()

        def impact(e):
            if e["status"] == "pending":
                return "该修订尚无人确认，所有当班人员必须确认此版本。"
            if e["status"] == "superseded":
                return "旧修订已被新版紧急卡取代：旧确认留在旧版，新风险必须重新确认，不自动覆盖。"
            if e["status"] == "withdrawn":
                return "已被管理员撤回，不再要求确认；历史确认保留可追溯。"
            return "本版已完成确认；若之后又有新版，仍需对新版重新确认。"

        def brief(e):
            rev = conn.execute("SELECT * FROM card_revision WHERE id=?", (e["card_revision_id"],)).fetchone()
            pending_people = []
            if e["status"] == "pending":
                confirmed = {r["person_id"] for r in conn.execute(
                    "SELECT person_id FROM confirmation WHERE entry_id=?", (e["id"],))}
                pending_people = [m["name"] for m in self._shift_members(conn, sid)
                                  if m["id"] not in confirmed]
            return {"entry_id": e["id"], "card_id": e["card_id"], "revision_id": e["card_revision_id"],
                    "rev": rev["rev"], "title": rev["title"], "content_hash": rev["content_hash"],
                    "status": e["status"], "added_at": e["added_at"], "note": e["note"],
                    "superseded_by_entry": e["superseded_by_entry"], "origin_entry": e["origin_entry"],
                    "impact_on_open_confirmations": impact(e), "pending_persons": pending_people}

        frozen_ids = {e["card_id"] for e in frozen}
        new_emergency = [brief(e) for e in supp
                         if e["origin_entry"] is None and e["status"] != "withdrawn"]
        revisions_in_shift = [brief(e) for e in supp
                              if e["origin_entry"] is not None or
                              (e["card_id"] in frozen_ids and e["status"] != "withdrawn")]
        self._send_json({
            "frozen_list": [brief(e) for e in frozen],
            "supplement_list": [brief(e) for e in supp],
            "new_emergency_cards": new_emergency,
            "in_shift_revision_updates": revisions_in_shift,
            "summary": (f"冻结 {len(frozen)} 项；增补 {len(supp)} 项，其中全新紧急卡 "
                        f"{len(new_emergency)} 项。增补/修订均为新条目，旧确认不迁移，未完成者按新条目重新确认。"),
        })

    def api_shift_ledger(self, conn, sid):
        """追溯台账：谁、对哪一版(content_hash/rev)、何时、在何种时机确认，而非只给完成百分比。"""
        self._shift_or_404(conn, sid)
        self._session_person(conn)
        rows = conn.execute(
            """SELECT c.*, p.name person_name, p.employee_no,
                      cr.rev, cr.content_hash, cr.title, cr.status rev_status,
                      e.list_type, e.status entry_status
               FROM confirmation c
               JOIN person p ON p.id=c.person_id
               JOIN card_revision cr ON cr.id=c.card_revision_id
               JOIN shift_card_entry e ON e.id=c.entry_id
               WHERE c.shift_id=? ORDER BY c.confirmed_at""", (sid,)).fetchall()
        records = [{"confirmation_id": r["id"], "person_id": r["person_id"],
                    "person_name": r["person_name"], "employee_no": r["employee_no"],
                    "entry_id": r["entry_id"], "list_type": r["list_type"],
                    "entry_status_now": r["entry_status"],
                    "card_revision_id": r["card_revision_id"], "rev": r["rev"],
                    "content_hash": r["content_hash"], "title": r["title"],
                    "revision_status_now": r["rev_status"],
                    "confirmed_at": r["confirmed_at"], "client_clock": r["client_clock"],
                    "clock_skew_secs": r["clock_skew_secs"], "timing": r["timing"],
                    "created_via": r["created_via"]} for r in rows]
        events = conn.execute(
            """SELECT * FROM event_log WHERE
               (entity_type='shift' AND entity_id=?)
               OR (entity_type='card' AND entity_id IN
                   (SELECT DISTINCT card_id FROM shift_card_entry WHERE shift_id=?))
               ORDER BY id""",
            (sid, sid)).fetchall()
        self._send_json({"records": records,
                         "events": [{"type": e["event_type"], "at": e["created_at"],
                                     "actor": e["actor"], "payload": json.loads(e["payload"])}
                                    for e in events]})

    # =====================================================================
    # 展示端 bundle / 确认
    # =====================================================================
    def api_display_bundle(self, conn, sid):
        """展示端拉取数据（可带可选 token）。未验证身份也允许查看，但响应标明未验证。"""
        s = self._shift_or_404(conn, sid)
        token = self._token()
        verified = None
        if token:
            row = conn.execute("SELECT * FROM session WHERE token=?", (token,)).fetchone()
            if row and parse_iso(row["expires_at"]) > dt.datetime.now(dt.timezone.utc):
                p = conn.execute("SELECT * FROM person WHERE id=?", (row["person_id"],)).fetchone()
                if p and p["active"]:
                    verified = row_person(p)
        rows = conn.execute(
            """SELECT * FROM shift_card_entry WHERE shift_id=?
               AND status IN ('pending','confirmed','superseded') ORDER BY list_type DESC, added_at,id""",
            (sid,)).fetchall()
        entries = []
        member_ids = {m["id"] for m in self._shift_members(conn, sid)}
        for e in rows:
            d = entry_detail(conn, e, False)
            confirmed_by = [{"person_id": r["person_id"], "confirmed_at": r["confirmed_at"],
                             "timing": r["timing"]}
                            for r in conn.execute(
                                "SELECT person_id,confirmed_at,timing FROM confirmation WHERE entry_id=?",
                                (e["id"],))]
            d["confirmed_by"] = confirmed_by
            d["viewer_confirmed"] = bool(verified and any(
                c["person_id"] == verified["id"] for c in confirmed_by))
            d["requires_confirmation"] = verified["id"] in member_ids if verified else False
            entries.append(d)
        self._send_json({
            "shift": {"id": s["id"], "name": s["name"], "start_at": s["start_at"],
                      "end_at": s["end_at"], "handed_over": bool(s["handed_over"]),
                      "handed_over_at": s["handed_over_at"]},
            "entries": entries,
            "members": self._shift_members(conn, sid),
            "server_time": now_utc(),
            "identity_verified": bool(verified),
            "viewer": verified,
            "disclaimer": "本系统仅传达经人工审核的安全提示，不代替现场防护措施，也不代替设备安全联锁。"
                          "确认按钮表示“已知悉本版提示”，不表示风险已消除。",
        })

    def api_confirm(self, conn, sid):
        """
        确认：必须绑定 具体卡片修订 + 班次 + 已验证人员。
        - 幂等：同人对同一 entry+revision 重复提交返回已有确认（用于离线重放/重发）。
        - 旧修订（条目已 superseded/withdrawn）拒绝，要求确认新版。
        - 非当班人员拒绝；记录客户端时钟与时钟误差；交班后标记 LATE_AFTER_HANDOVER。
        """
        s = self._shift_or_404(conn, sid)
        p = self._session_person(conn, "display")
        d = self._read_json()
        try:
            entry_id = int(d.get("entry_id"))
            rev_id = int(d.get("card_revision_id"))
        except (TypeError, ValueError):
            raise ApiError(400, "BAD_FIELD", "entry_id 与 card_revision_id 必填")

        e = conn.execute("SELECT * FROM shift_card_entry WHERE id=? AND shift_id=?",
                         (entry_id, sid)).fetchone()
        if not e:
            raise ApiError(404, "NO_ENTRY", "条目不存在或不属于该班次")
        if e["card_revision_id"] != rev_id:
            # 客户端拿着旧卡片的修订来确认
            latest = conn.execute(
                """SELECT * FROM shift_card_entry WHERE shift_id=? AND card_id=?
                   AND status IN ('pending','confirmed') ORDER BY id DESC LIMIT 1""",
                (sid, e["card_id"])).fetchone()
            raise ApiError(409, "REVISION_MISMATCH",
                           "不能确认旧修订：该卡片在本班已有新版本，请确认当前版本",
                           {"current_entry_id": latest["id"] if latest else None,
                            "current_revision_id": latest["card_revision_id"] if latest else None})
        if e["status"] == "superseded":
            new = conn.execute("SELECT * FROM shift_card_entry WHERE id=?",
                               (e["superseded_by_entry"],)).fetchone()
            raise ApiError(409, "SUPERSEDED",
                           "该版本已被班中增补的新版取代，旧确认不能覆盖新风险，请确认新版",
                           {"current_entry_id": e["superseded_by_entry"],
                            "current_revision_id": new["card_revision_id"] if new else None})
        if e["status"] == "withdrawn":
            raise ApiError(410, "WITHDRAWN", "该卡片已被管理员撤回，无需确认（历史记录保留）")
        if not conn.execute("SELECT 1 FROM shift_member WHERE shift_id=? AND person_id=?",
                            (sid, p["id"])).fetchone():
            raise ApiError(403, "NOT_SHIFT_MEMBER", "你不是本班当班人员，不能代确认")

        server_now = dt.datetime.now(dt.timezone.utc)
        client_clock = parse_iso(d.get("client_clock"))
        skew = int((client_clock - server_now).total_seconds()) if client_clock else None

        st, en = parse_iso(s["start_at"]), parse_iso(s["end_at"])
        ho = parse_iso(s["handed_over_at"]) if s["handed_over_at"] else None
        if ho and server_now >= ho:
            timing = "LATE_AFTER_HANDOVER"
        elif server_now < st:
            timing = "ON_TIME"  # 班前预确认视为按时（验收用例主要覆盖交班后迟到）
        elif server_now > en and not s["handed_over"]:
            timing = "LATE_BEFORE_HANDOVER"
        else:
            timing = "ON_TIME"

        # 幂等：同人/同条目/同修订已有确认
        existing = conn.execute(
            "SELECT * FROM confirmation WHERE entry_id=? AND person_id=? AND card_revision_id=?",
            (entry_id, p["id"], rev_id)).fetchone()
        if existing:
            return self._send_json({"ok": True, "idempotent": True,
                                    "confirmation_id": existing["id"],
                                    "timing": existing["timing"],
                                    "confirmed_at": existing["confirmed_at"]})

        via = "offline_queue" if d.get("offline") else "online"
        cur = conn.execute(
            """INSERT INTO confirmation(entry_id,card_revision_id,shift_id,person_id,confirmed_at,
               client_clock,clock_skew_secs,timing,created_via) VALUES(?,?,?,?,?,?,?,?,?)""",
            (entry_id, rev_id, sid, p["id"], server_now.replace(microsecond=0).isoformat(),
             d.get("client_clock"), skew, timing, via))
        # 全员确认后条目置 confirmed（仅状态汇总，不代表风险消除）
        members = conn.execute("SELECT COUNT(*) c FROM shift_member WHERE shift_id=?", (sid,)).fetchone()["c"]
        done = conn.execute("SELECT COUNT(DISTINCT person_id) c FROM confirmation WHERE entry_id=?",
                            (entry_id,)).fetchone()["c"]
        if done >= members:
            conn.execute("UPDATE shift_card_entry SET status='confirmed' WHERE id=?", (entry_id,))
        log_event(conn, "confirmed", "confirmation", cur.lastrowid, p["id"],
                  {"entry_id": entry_id, "revision_id": rev_id, "timing": timing,
                   "clock_skew_secs": skew, "via": via})
        conn.commit()
        self._send_json({"ok": True, "confirmation_id": cur.lastrowid, "timing": timing,
                         "clock_skew_secs": skew, "server_time": now_utc(),
                         "meaning": "知悉确认（本版），不表示风险已消除"}, 201)

    def api_events(self, conn):
        self._session_person(conn)
        rows = conn.execute("SELECT * FROM event_log ORDER BY id DESC LIMIT 200").fetchall()
        self._send_json({"events": [{"id": r["id"], "type": r["event_type"],
                                     "entity": r["entity_type"], "entity_id": r["entity_id"],
                                     "actor": r["actor"], "at": r["created_at"],
                                     "payload": json.loads(r["payload"])} for r in rows]})


ROUTES = {
    ("POST", "/api/auth/login"): Handler.api_login,
    ("POST", "/api/auth/logout"): Handler.api_logout,
    ("GET", "/api/auth/me"): Handler.api_me,
    ("POST", "/api/auth/verify-pin"): Handler.api_verify_pin,
    ("GET", "/api/persons"): Handler.api_persons_list,
    ("POST", "/api/persons"): Handler.api_person_create,
    ("GET", "/api/cards"): Handler.api_cards_list,
    ("POST", "/api/cards"): Handler.api_card_create,
    ("GET", "/api/shifts"): Handler.api_shifts_list,
    ("POST", "/api/shifts"): Handler.api_shift_create,
    ("GET", "/api/events"): Handler.api_events,
}

# (method, regex, handler)
DYN_ROUTES = [
    (r"(?P<rid>\d+)", None),  # placeholder to keep structure obvious
]

def build_dyn_routes():
    import re
    return [
        ("POST", re.fullmatch if False else re.compile(r"^/api/cards/(?P<card_id>\d+)/revisions$"),
         Handler.api_revision_create),
        ("POST", re.compile(r"^/api/revisions/(?P<rev_id>\d+)/approve$"),
         Handler.api_revision_approve),
        ("POST", re.compile(r"^/api/cards/(?P<card_id>\d+)/withdraw$"),
         Handler.api_card_withdraw),
        ("POST", re.compile(r"^/api/shifts/(?P<sid>\d+)/freeze$"),
         Handler.api_shift_freeze),
        ("POST", re.compile(r"^/api/shifts/(?P<sid>\d+)/handover$"),
         Handler.api_shift_handover),
        ("GET", re.compile(r"^/api/shifts/(?P<sid>\d+)/entries$"),
         Handler.api_shift_entries),
        ("POST", re.compile(r"^/api/shifts/(?P<sid>\d+)/supplement$"),
         Handler.api_shift_supplement),
        ("GET", re.compile(r"^/api/shifts/(?P<sid>\d+)/diff$"),
         Handler.api_shift_diff),
        ("GET", re.compile(r"^/api/shifts/(?P<sid>\d+)/ledger$"),
         Handler.api_shift_ledger),
        ("GET", re.compile(r"^/api/display/(?P<sid>\d+)$"),
         Handler.api_display_bundle),
        ("POST", re.compile(r"^/api/display/(?P<sid>\d+)/confirm$"),
         Handler.api_confirm),
    ]

DYN_ROUTES = build_dyn_routes()

def main():
    import sys
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--seed", action="store_true", help="写入演示/验收种子数据")
    ap.add_argument("--init", action="store_true", help="仅初始化数据库")
    args = ap.parse_args()
    init_db(seed=args.seed)
    if args.init:
        print("db initialized at", DB_PATH)
        return
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Safety display server on http://0.0.0.0:{args.port}  (db={DB_PATH})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
