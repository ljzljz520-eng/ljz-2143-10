#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收测试：启动独立服务进程（临时数据库，写入种子），通过 HTTP 验证全部关键场景。
覆盖：发布审核 / 整班冻结 / 班中增补状态迁移 / 版本绑定确认 / 交班前后迟到回执 /
     管理员撤回 / 两人共用终端 / 时钟误差 / 无身份只看不确认 / 幂等 / 离线补传 /
     旧卡确认不能覆盖新风险 / 追溯到“谁确认了哪一版” / 宣传图静态资源。
"""
import json, os, subprocess, sys, time, tempfile, urllib.request, urllib.error, datetime as dt

PORT = int(os.environ.get("TEST_PORT", "8091"))
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = tempfile.mktemp(prefix="safety_test_", suffix=".db")

passed, failed = 0, 0
def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  ✓ {name}")
    else:
        failed += 1; print(f"  ✗ {name}  {detail}")

def req(method, path, token=None, body=None, raw_clock=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=8) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: payload = json.loads(e.read().decode())
        except Exception: payload = {}
        return e.code, payload

def login(no, pin, purpose="admin"):
    st, d = req("POST", "/api/auth/login", body={"employee_no": no, "pin": pin, "purpose": purpose})
    return d.get("token"), d

def iso(offset_hours):
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=offset_hours)).replace(microsecond=0).isoformat()

def main():
    env = os.environ.copy(); env["SAFETY_DB"] = DB
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"),
                             "--port", str(PORT), "--seed"],
                            cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE+"/static/poster.svg", timeout=1); break
            except Exception: time.sleep(0.1)
        else:
            print("server failed to start"); print(proc.stderr.read().decode()); sys.exit(1)

        print("\n[1] 身份验证：错误 PIN 不得产生会话")
        st, d = req("POST", "/api/auth/login", body={"employee_no":"E001","pin":"0000","purpose":"display"})
        check("错误PIN返回401", st==401 and d["error"]=="BAD_CREDENTIALS", str(d))
        st, d = req("GET", "/api/auth/me")
        check("无token访问me返回401", st==401)

        print("\n[2] 种子班次（已交班）+ 宣传图可达")
        admin, _ = login("A001","1111")
        st, d = req("GET","/api/shifts",admin)
        s1 = next(x for x in d["shifts"] if x["id"]==1)
        check("种子班次已交班", s1["handed_over"] is True)
        check("种子班次2名当班人员", len(s1["members"])==2)
        with urllib.request.urlopen(BASE+"/static/poster.svg") as r:
            check("宣传图SVG可访问", r.status==200 and b"<svg" in r.read())

        print("\n[3] 未验证身份可查看展示bundle，但无确认能力")
        st, b = req("GET","/api/display/1")
        check("匿名可看bundle", st==200 and b["identity_verified"] is False)
        check("含免责声明", "不代替现场防护" in b["disclaimer"] and "不表示风险已消除" in b["disclaimer"])
        st, d = req("POST","/api/display/1/confirm",
                    body={"entry_id":b["entries"][0]["id"],
                          "card_revision_id":b["entries"][0]["card_revision_id"],
                          "client_clock":iso(0)})
        check("匿名确认被拒401", st==401, str(d))

        print("\n[4] 冻结清单：只有已审核卡片可冻结；draft/审核流")
        st, d = req("POST","/api/cards",admin,{
            "title":"临时动火风险","risk_text":"焊接火花可能引燃周边可燃物。",
            "measure_text":"清理可燃物、配备灭火器、动火监护人在位。",
            "responsible":"李娜","image_url":"/static/missing-broken.png"})
        cid4 = d["id"]; check("创建卡片成功(首版draft)", st==201)
        st, cards = req("GET","/api/cards",admin)
        draft_rev = next(r for c in cards["cards"] if c["id"]==cid4 for r in c["revisions"] if r["rev"]==1)
        check("首版状态为draft", draft_rev["status"]=="draft")
        st, d = req("POST", f"/api/shifts", admin, {"name":"测试夜班","start_at":iso(1),"end_at":iso(9),"member_ids":[2,3]})
        sid = d["id"]
        st, d = req("POST", f"/api/shifts/{sid}/freeze", admin, {"card_ids":[cid4]})
        check("draft卡片不能上冻结清单(409)", st==409 and d["error"]=="NO_APPROVED_REV", str(d))
        st, d = req("POST", f"/api/revisions/{draft_rev['id']}/approve", admin)
        check("人工审核通过", st==200)
        st, d = req("POST", f"/api/shifts/{sid}/freeze", admin, {"card_ids":[cid4]})
        frozen_e = d["frozen"][0]
        check("冻结成功并绑定具体修订hash", st==200 and frozen_e["revision_id"]==draft_rev["id"])
        st, d = req("POST", f"/api/shifts/{sid}/freeze", admin, {"card_ids":[]})
        check("重复冻结被拒(409)", st==409 and d["error"]=="ALREADY_FROZEN")

        print("\n[5] 当班人员确认：版本绑定 / 非当班拒绝 / 幂等 / 时钟误差")
        wang, _ = login("E001","2222","display")
        li, _ = login("E002","3333","display")
        eid = frozen_e["entry_id"]; rid = frozen_e["revision_id"]
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0)})
        check("王强按时确认成功", st==201 and d["timing"]=="ON_TIME", str(d))
        st2, d2 = req("POST", f"/api/display/{sid}/confirm", wang,
                      {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0)})
        check("重复确认幂等", st2==200 and d2.get("idempotent") is True)
        st, d = req("POST", f"/api/display/{sid}/confirm", li,
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0.001)})
        check("全员确认后条目汇总为confirmed", st==201)
        st, entries = req("GET", f"/api/shifts/{sid}/entries", admin)
        e0 = next(x for x in entries["entries"] if x["id"]==eid)
        check("条目状态=confirmed", e0["status"]=="confirmed", e0["status"])
        skew_clock = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=600)).replace(microsecond=0).isoformat()
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":skew_clock})
        # 已幂等，无法观测skew；改用新卡新场景在下方补充时钟误差用例
        # 非当班人员：用管理员display会话不在本班
        st, d = req("POST", f"/api/shifts", admin,
                    {"name":"路人班","start_at":iso(-10),"end_at":iso(10),"member_ids":[1]})
        other_sid = d["id"]
        st, d = req("POST", f"/api/display/{other_sid}/confirm", wang,
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0)})
        check("跨班条目404", st==404)
        # 王强在路人班无条目但可构造：用非本班成员对本班条目
        st, d = req("POST", f"/api/display/{sid}/confirm",
                    login("A001","1111","display")[0],
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0)})
        check("非当班管理员不能代确认(403)", st==403 and d["error"]=="NOT_SHIFT_MEMBER", str(d))

        print("\n[6] 班中增补：新紧急卡 + 旧版换新；旧确认不迁移、不覆盖")
        # 新紧急卡（种子card 3 吊装）
        st, d = req("POST", f"/api/shifts/{sid}/supplement", admin,
                    {"card_ids":[3], "note":"吊装作业临时进场"})
        ch = d["changes"][0]
        check("全新紧急卡=增补新条目", ch["kind"]=="new_card" and ch["entry_id"]!=eid, str(ch))
        new_card_entry = ch["entry_id"]
        # 对 card4 出新版本（更新风险）
        st, d = req("POST", f"/api/cards/{cid4}/revisions", admin, {
            "title":"临时动火风险(升级)","risk_text":"焊接火花可能引燃周边可燃物；且周边新增油漆桶，风险升级！",
            "measure_text":"清理可燃物及易燃品、配备双倍灭火器、双人监护。",
            "responsible":"李娜","image_url":"/static/poster.svg"})
        rev2_id = d["id"]
        st, d = req("POST", f"/api/revisions/{rev2_id}/approve", admin)
        check("第2版审核通过", st==200)
        st, d = req("POST", f"/api/shifts/{sid}/supplement", admin, {"card_ids":[cid4]})
        chg = d["changes"][0]
        check("换版增补标记 revision_update", chg["kind"]=="revision_update", str(chg))
        check("旧条目被标记superseded", chg["superseded_entry"]==eid, str(chg))
        new_rev_entry = chg["entry_id"]
        # 关键：拿旧修订去确认新条目 / 旧条目
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":new_rev_entry,"card_revision_id":rid,"client_clock":iso(0)})
        check("旧修订不能确认新条目 REVISION_MISMATCH(409)", st==409 and d["error"]=="REVISION_MISMATCH", str(d))
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":eid,"card_revision_id":rid,"client_clock":iso(0)})
        check("旧条目(superseded)确认被拒 SUPERSEDED(409)", st==409 and d["error"]=="SUPERSEDED", str(d))
        # 新修订必须两人重新确认
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":new_rev_entry,"card_revision_id":rev2_id,"client_clock":iso(0)})
        check("王强确认新版成功", st==201)
        st, d = req("POST", f"/api/display/{sid}/confirm", li,
                    {"entry_id":new_rev_entry,"card_revision_id":rev2_id,"client_clock":iso(0)})
        check("李娜确认新版成功", st==201)
        # 新紧急卡同样要确认
        st, ent = req("GET", f"/api/shifts/{sid}/entries", admin)
        ne = next(x for x in ent["entries"] if x["id"]==new_card_entry)
        st, d = req("POST", f"/api/display/{sid}/confirm", wang,
                    {"entry_id":new_card_entry,"card_revision_id":ne["card_revision_id"],
                     "client_clock":iso(0)})
        check("新紧急卡王强已确认", st==201)

        print("\n[7] 冻结 vs 增补差异：影响说明齐全")
        st, d = req("GET", f"/api/shifts/{sid}/diff", admin)
        check("差异摘要含两类清单数量", "冻结" in d["summary"] and "增补" in d["summary"])
        titles = [x["card_id"] for x in d["new_emergency_cards"]]
        check("新紧急卡出现在new_emergency_cards", 3 in titles, str(titles))
        upd = [x for x in d["in_shift_revision_updates"] + d["frozen_list"] if x["card_id"]==cid4]
        check("换版条目说明旧确认不迁移",
              any("重新确认" in x["impact_on_open_confirmations"] for x in upd), str(upd))

        print("\n[8] 管理员撤回：在班条目withdrawn，历史保留可追溯，再确认410")
        st, d = req("POST", "/api/cards/3/withdraw", admin)
        check("撤回返回受影响条目", st==200 and new_card_entry in d["entries_withdrawn"], str(d))
        st, d = req("POST", f"/api/display/{sid}/confirm", li,
                    {"entry_id":new_card_entry,"card_revision_id":ne["card_revision_id"],
                     "client_clock":iso(0)})
        check("撤回后确认返回410", st==410 and d["error"]=="WITHDRAWN", str(d))
        st, led = req("GET", f"/api/shifts/{sid}/ledger", admin)
        rec = [x for x in led["records"] if x["entry_id"]==new_card_entry]
        check("撤回不删除已有确认记录", any(x["person_name"]=="王强" for x in rec), str(rec))
        check("台账记录绑定rev+hash", all(x["content_hash"] and x["rev"] for x in led["records"]))

        print("\n[9] 交班后迟到回执 + 交班后禁止增补/冻结")
        st, d = req("POST", f"/api/shifts/{sid}/handover", admin)
        check("交班成功", st==200 and d.get("handed_over_at"))
        # 再建一张已审核卡用于迟到确认（撤回card3后用其entry已withdrawn；新建一张补进种子已交班班次1）
        st, d = req("POST","/api/cards",admin,{
            "title":"夜间巡检风险","risk_text":"照明不足，通道有管线绊脚风险。",
            "measure_text":"佩戴头灯、沿绿色通道行走。","responsible":"王强"})
        cid9=d["id"]
        rr=next(r for c in (req("GET","/api/cards",admin)[1]["cards"]) if c["id"]==cid9 for r in c["revisions"])
        req("POST", f"/api/revisions/{rr['id']}/approve", admin)
        # 种子班次1在创建时即已交班；把新卡增补到它——交班后应被拒绝；改用直接验证：
        st, d = req("POST", "/api/shifts/1/supplement", admin, {"card_ids":[cid9]})
        check("交班后禁止增补(409)", st==409 and d["error"]=="ALREADY_HANDED_OVER", str(d))
        # 迟到回执：王强对种子班次1中尚未确认的冻结条目进行确认（已交班）
        st, b1 = req("GET","/api/display/1")
        open_entry = next(x for x in b1["entries"] if x["status"]=="pending")
        st, d = req("POST","/api/display/1/confirm", wang,
                    {"entry_id":open_entry["id"],
                     "card_revision_id":open_entry["card_revision_id"],"client_clock":iso(0)})
        check("交班后确认标记 LATE_AFTER_HANDOVER", st==201 and d["timing"]=="LATE_AFTER_HANDOVER", str(d))
        # LATE_BEFORE_HANDOVER：下班时间已过但尚未交班的班次
        st, d = req("POST","/api/shifts",admin,{"name":"拖更班","start_at":iso(-5),"end_at":iso(-1)})
        sid_late=d["id"]
        req("POST", f"/api/shifts/{sid_late}/members", admin, {"person_ids":[2]}) if False else None
        # 通过创建班次接口无法带成员：直接SQLite外部进程无法连——改为重新创建带成员班次
        st, d = req("POST","/api/shifts",admin,{"name":"拖更班2","start_at":iso(-5),"end_at":iso(-1),"member_ids":[2,3]})
        sid_late=d["id"]
        st, d = req("POST", f"/api/shifts/{sid_late}/freeze", admin, {"card_ids":[1]})
        e_late=d["frozen"][0]
        st, d = req("POST", f"/api/display/{sid_late}/confirm", wang,
                    {"entry_id":e_late["entry_id"],"card_revision_id":e_late["revision_id"],
                     "client_clock":iso(0)})
        check("过点未交班确认标记 LATE_BEFORE_HANDOVER", st==201 and d["timing"]=="LATE_BEFORE_HANDOVER", str(d))

        print("\n[10] 时钟误差：客户端时钟偏差被记录")
        st, d = req("POST", f"/api/display/{sid_late}/confirm", li,
                    {"entry_id":e_late["entry_id"],"card_revision_id":e_late["revision_id"],
                     "client_clock":skew_clock})
        check("偏差>60s被记录clock_skew_secs", st==201 and abs(d["clock_skew_secs"])>60, str(d))
        st, led = req("GET", f"/api/shifts/{sid_late}/ledger", admin)
        row = [x for x in led["records"] if x["person_name"]=="李娜"][0]
        check("台账可见时钟误差列", abs(row["clock_skew_secs"])>60, str(row))

        print("\n[11] 两人共用终端：会话隔离，换人不冒用")
        # 王强的 display token 不能再被当作李娜；二次验证PIN错误拒绝
        st, d = req("POST","/api/auth/verify-pin",wang,{"pin":"9999"})
        check("二次验证错误PIN被拒", st==401 and d["error"]=="BAD_PIN")
        st, d = req("POST","/api/auth/verify-pin",wang,{"pin":"2222"})
        check("二次验证正确PIN通过", st==200)
        # logout 后 token 失效
        req("POST","/api/auth/logout",wang)
        st, d = req("GET","/api/auth/me",wang)
        check("退出后会话失效", st==401)

        print("\n[12] 离线补传语义：offline标记 + 换版拒绝 + 幂等")
        wang, _ = login("E001","2222","display")
        # 新班次+冻结card1，王强离线确认后补传成功
        st, d = req("POST","/api/shifts",admin,{"name":"离线班","start_at":iso(-1),"end_at":iso(8),"member_ids":[2,3]})
        sid_off=d["id"]
        st, d = req("POST", f"/api/shifts/{sid_off}/freeze", admin, {"card_ids":[1]})
        e_off=d["frozen"][0]
        st, d = req("POST", f"/api/display/{sid_off}/confirm", wang,
                    {"entry_id":e_off["entry_id"],"card_revision_id":e_off["revision_id"],
                     "client_clock":iso(0),"offline":True})
        check("offline=true补传成功且记录来源", st==201)
        st, led = req("GET", f"/api/shifts/{sid_off}/ledger", admin)
        check("台账标记离线补传来源", led["records"][0]["created_via"]=="offline_queue")
        # 补传一个已经被换版的旧修订：在 sid_off 增补card1 rev2（先做新版）
        st, d = req("POST","/api/cards/1/revisions",admin,{
            "title":"高处作业坠落风险","risk_text":"护栏拆除且有湿滑，坠落风险升级。",
            "measure_text":"双钩安全带+防滑鞋+监护人。","responsible":"王强","image_url":"/static/poster.svg"})
        r1v2=d["id"]; req("POST",f"/api/revisions/{r1v2}/approve",admin)
        st, d = req("POST", f"/api/shifts/{sid_off}/supplement", admin, {"card_ids":[1]})
        sup=d["changes"][0]; e_new=sup["entry_id"]
        st, d = req("POST", f"/api/display/{sid_off}/confirm", li,
                    {"entry_id":e_off["entry_id"],"card_revision_id":e_off["revision_id"],
                     "client_clock":iso(0),"offline":True})
        check("离线旧版补传被拒 SUPERSEDED", st==409 and d["error"]=="SUPERSEDED", str(d))
        check("响应指向新条目", d.get("current_entry_id")==e_new, str(d))

        print("\n[13] 追溯：谁确认了哪一版（不是只给百分比）")
        st, led = req("GET", f"/api/shifts/{sid}/ledger", admin)
        persons_versions = {(x["person_name"], x["rev"]) for x in led["records"]}
        check("台账含王强的v1与v2确认", ("王强",1) in persons_versions and ("王强",2) in persons_versions,
              str(persons_versions))
        check("每条记录含content_hash与时间", all(x["content_hash"] and x["confirmed_at"] for x in led["records"]))
        ev_types = {e["type"] for e in led["events"]}
        check("事件链含冻结/增补/交班/撤回",
              {"shift_frozen","shift_supplemented","shift_handed_over","card_withdrawn"} <= ev_types,
              str(ev_types))

        print("\n[14] 权限：普通班员不能管理卡片/班次")
        st, d = req("GET","/api/persons", li)
        check("班员不能列人员(403)", st==403)
        st, d = req("POST","/api/cards", li, {"title":"x","risk_text":"y"})
        check("班员不能建卡(403)", st==403)

        print("\n[15] 坏图/无图与页面可达性（HTTP层）")
        try:
            with urllib.request.urlopen(BASE+"/static/missing-broken.png") as r:
                bad = r.status
        except urllib.error.HTTPError as e:
            bad = e.code
        check("坏图URL返回404（前端onerror触发文字降级）", bad==404)
        for pth in ("/", "/admin/", "/display/", "/static/style.css", "/static/display.js", "/static/admin.js"):
            with urllib.request.urlopen(BASE+pth) as r:
                check(f"资源可达 {pth}", r.status==200)

        print(f"\n==== 结果：{passed} 通过，{failed} 失败 ====")
        if failed:
            sys.exit(1)
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except Exception: proc.kill()
        for f in (DB, DB+"-wal", DB+"-shm"):
            try: os.remove(f)
            except OSError: pass

if __name__ == "__main__":
    main()
