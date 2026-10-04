# 车间安全提示展示系统

零依赖实现（Python 3 标准库 + SQLite）：

| 组成 | 入口 | 说明 |
|---|---|---|
| 服务 API | `server.py`（端口 8080） | 发布审核、冻结/增补/交班、撤回、版本化确认全部入库 |
| Web 管理端 | <http://localhost:8080/admin/> | 维护班次、卡片与修订、审核、增补、追溯台账 |
| 车间展示端（C 窗口） | <http://localhost:8080/display/> | 宣传图叠加当班风险与负责人；全屏/非全屏均可操作 |

## 运行

```bash
python3 server.py --seed          # 初始化库并写入演示数据（已交班班次+2冻结卡+坏图卡）
# 浏览器：
#   http://localhost:8080/         管理端
#   http://localhost:8080/display/ 车间展示端
python3 tests/acceptance.py       # 61 项验收（自动起独立临时库与端口 8091）
```

演示账号：管理员 `A001/1111`；当班人员 `E001/2222 王强`、`E002/3333 李娜`。

## 核心原则如何落地

1. **只传达经人工审核的提示**：卡片新建/修订均为 `draft`，管理员显式“审核通过”(approved)
   后才能进入冻结或增补清单；系统不自动发布。
2. **确认三绑定**：每条 `confirmation` 必须同时绑定
   `card_revision_id`（具体版本，含 content_hash）+ `shift_id`（班次）+ `person_id`（已验证人员）。
   展示端会话只存内存，确认前对 PIN **二次验证**；未验证身份只能查看，接口直接 401，不存在匿名确认。
3. **按钮不是“风险消除”**：界面文案统一为“我已知悉第 N 版提示”，确认后仍提示
   “不表示风险已消除”；底部常驻“不代替现场防护/设备联锁”声明。
4. **旧卡确认不覆盖新风险**：班中增补换版时，旧条目标记 `superseded` 并指向新条目；
   拿旧修订确认新条目 → `409 REVISION_MISMATCH`；确认已取代条目 → `409 SUPERSEDED`，
   响应带回当前应确认的条目/修订；旧确认留在旧版本，必须对新版重新确认。
5. **撤回不是删除**：管理员撤回 → 修订 `withdrawn`、在班条目 `withdrawn`、再确认返回
   `410`；历史确认与事件链完整保留可追溯。
6. **追溯到人到版**：班次台账逐条列出 谁 → 第几版 → content_hash → 服务器时间 →
   时机（按时/交班前后迟到）→ 时钟误差 → 在线或离线补传，而不是只显示完成百分比。

## 整班冻结 vs 班中增补：状态迁移

| 场景 | 迁移 | 对未完成确认的影响 |
|---|---|---|
| 班前会冻结 | 已审核卡片 → entry(`frozen`,`pending`)，绑定修订 | 当班人员逐人确认 |
| 班中加入全新紧急卡 | 新 entry(`supplement`,`pending`) | 所有人必须确认该卡 |
| 班中为在班卡发布新版并增补 | 旧 entry → `superseded`（指向新 entry）；新 entry(`supplement`,`pending`) | 旧确认不迁移；未确认者必须确认新修订；已确认旧版者同样要确认新版 |
| 全员确认 | entry → `confirmed`（仅汇总态） | 之后若再出新版，旧 entry 变 `superseded`，新 entry 重新待确认 |
| 管理员撤回 | entry → `withdrawn` | 不再要求确认，历史保留 |
| 交班后到达的确认 | `timing=LATE_AFTER_HANDOVER` | 界面与台账红色标注；交班后禁止再增补 |
| 过下班点但未交班 | `timing=LATE_BEFORE_HANDOVER` | 同上如实标注 |

`GET /api/shifts/{id}/diff` 返回两份清单与每项 `impact_on_open_confirmations` 文字说明。

## 离线 / 时钟 / 图片降级（C 窗口）

- **离线保留提示**：每次成功拉取的 bundle 存 localStorage；离线时继续展示并显示
  “最后成功更新时间”和红色离线横幅，轮询每 20 秒重试。
- **离线确认队列**：离线期间的知悉确认绑定 人员+条目+修订+客户端时钟 暂存；恢复后**仅补传本人**队列。
  若所绑版本已换版/撤回，服务端拒绝，前端丢弃该条并提示对新版重新确认——绝不把旧确认写到新版上。
- **时钟误差**：服务器时间为权威；确认时记录 `client_clock` 与偏差秒数，偏差 >60s
  在界面和台账标 ⚠；补传与迟到判定均以服务器时钟为准。
- **图片解码失败**：宣传图失败 → 纯色文字背景；卡片配图失败/缺失（如种子里的
  `/static/missing-broken.png` 与无图卡）→ 黄色/红色文字块，风险、措施、负责人等文字内容始终完整呈现。
- **退出全屏**：全屏只是视图模式，顶栏（换班、身份验证、切换人员、全屏、管理端入口）始终在 DOM 中可达。
- **两人共用终端**：换人必须“切换人员”并重新工号+PIN；会话不持久化到磁盘。

## 主要接口

```
POST /api/auth/login {employee_no,pin,purpose=admin|display}
POST /api/auth/verify-pin            # 确认前二次验证
POST /api/cards                      # 建卡(草稿)
POST /api/cards/{id}/revisions       # 新修订(草稿)
POST /api/revisions/{id}/approve     # 人工审核
POST /api/cards/{id}/withdraw        # 管理员撤回
POST /api/shifts /api/shifts/{id}/freeze|handover|supplement
GET  /api/shifts/{id}/diff|entries|ledger
GET  /api/display/{id}               # 匿名可查看，带token返回身份
POST /api/display/{id}/confirm       # 三绑定确认（幂等）
```

## 需求—验收对照（tests/acceptance.py，61 项全过）

交班后迟到回执(§9)、交班前后两种迟到分类(§9)、管理员撤回(§8)、两人共用终端/二次验证(§11)、
时钟误差(§10)、图片解码失败与页面资源可达(§15)、离线保留与补传/换版拒绝(§3/§12)、
旧卡确认不覆盖新版(§6)、冻结与增补差异及影响(§7)、追溯谁确认哪一版(§13)、权限(§1/§14)。

## 边界说明

演示用 PIN 以“工号:PIN”做 SHA-256 存储；生产部署应置于 HTTPS 与真实目录服务/硬件身份验证之后。
