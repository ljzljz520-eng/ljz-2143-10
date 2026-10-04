# 车间安全提示展示系统

由 **C 窗口（车间大屏展示）**、**Web 管理端**、**服务 API + 数据库** 三部分组成。

> 系统仅传达经用户审核的安全提示，**不代替现场防护设施或设备安全联锁**。
> 点击"确认已知悉"只表示人员阅读了**某一具体卡片修订**，**不表示风险已经消除**。

## 启动

```bash
npm install        # 仅依赖 express（零原生模块）
npm start         # 默认 http://localhost:3000
```

- C 窗口（大屏）：http://localhost:3000/c/
- Web 管理端：http://localhost:3000/admin/
- 数据文件：`data/db.json`（原子写入，损坏自动备份重建）

演示账号：

| 端 | 账号 | 凭证 |
|---|---|---|
| 管理端 | admin | admin123 |
| C 窗口 | p_wang / p_li / p_zhao / p_sun | 123456 / 234567 / 345678 / 456789 |

## 核心模型与状态迁移

- **整班冻结清单**：开班瞬间把当时全部"已发布"卡片按当前修订号快照进班（`frozen`），并为每个班次成员生成待确认。
- **班中增补清单**：开班后新增紧急卡（`supplement`）或卡片换版（`revision`）独立标记。
- **新增紧急卡的影响**：立即为当班全体在岗成员新建"待确认"；**不影响**其它卡片已有确认。
- **卡片发布新版（修订）**：旧版条目变为 `superseded`，旧版未确认项迁移失效；
  新版为**全员**重新生成待确认——**包括已经确认旧版的人**（旧卡确认不能覆盖新风险）；确认旧版会被 409 拒绝。
- **管理员撤回**：未确认项迁移为 `withdrawn` 并禁止确认；历史确认记录保留可追溯。
- **交班**：未完成确认结转（`carried`），可在 C 窗口补交为**迟到回执**（`confirmed_late`），明确标注交班后、不按时确认冒充。

确认状态机：

```
pending ──本人确认(班中)────────► confirmed
pending ──卡片换版(未确认)──────► superseded        （新版另起 pending）
pending ──管理员撤回────────────► withdrawn
pending ──交班时仍未完成────────► carried ──补交──► confirmed_late
confirmed / confirmed_late 永久保留，不可被任何操作改写
```

## 关键安全语义

- 每条确认绑定 **卡片修订号 + 班次 + 已验证人员（工号+PIN）**，追溯到"谁确认了哪一版"，而非只看完成百分比。
- 确认时间以**服务端时钟**为准；同时保存终端时钟与偏差（clock skew），偏差>60s 在界面和追溯中告警标注。
- **设备离线**：C 窗口继续显示最后同步内容并标注更新时间；确认按钮停用，联网后恢复，绝不生成离线/伪造确认。
- **无法验证身份**：仍可浏览全部提示，但确认接口一律 401。
- **两人共用终端**：每次确认前须重新输 PIN；一次确认完成后会话即清除，防止替人确认。
- **图片解码失败**：`onerror` 降级为文字占位，标题/风险/正文/负责人等全部内容照常显示；无配图卡同样纯文字呈现。
- **退出全屏**：不依赖全屏，顶部与页脚始终保留全屏切换、身份验证、管理端入口等可达操作；页面不使用 F11 屏蔽。

## 验收场景（已自动化，62 项断言）

端到端脚本 `/tmp/accept.js` 覆盖：

1. 交班前后迟到回执（`carried → confirmed_late`，文案与状态均正确）
2. 管理员撤回卡片（未确认迁移、确认被拒、历史保留）
3. 两人共用终端（PIN 隔离、确认后清会话、按人 catchup）
4. 时钟误差（5 分钟偏差仍按服务端时间记录并标告警）
5. 图片解码失败（缺失资源 404 → 前端文字降级占位）
6. 整班冻结 vs 班中增补清单对比、紧急卡对未完成确认零影响
7. 新版迁移（已确认旧版者也必须重认新版）
8. 权限隔离（人员 token 不能调管理 API）

手动复现建议：
- 离线：浏览器 DevTools → Network → Offline，C 窗口出现离线横幅且可继续阅读。
- 图片失败：管理端把卡片配图改成 `/assets/missing.png`，C 窗口显示文字占位。
- 追溯：管理端「确认追溯」按班次/卡片/人员过滤，可看到修订号与时间。

## API 摘要

- `POST /api/auth/person|admin`、`GET /api/auth/me`、`POST /api/auth/logout`
- `GET /api/board?shiftId=`（免登录查看）、`GET /api/time`
- `GET /api/my/catchup`、`POST /api/confirmations`（需人员会话）
- `/api/admin/persons*`、`/api/admin/cards*`（含 `/publish`、`/revise`、`/withdraw`、`/revisions`）
- `/api/admin/shifts*`（含 `/activate`、`/supplement`、`/members`、`/handover`、`/migration-report`）
- `GET /api/admin/traces`、`GET /api/admin/audit`
