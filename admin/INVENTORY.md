# 新后台功能清单（W33-b 验收依据）

> 状态：W33-b 第一步产出（2026-10-07），基于 akari-panel `origin/main`（db41630）。
> 用途：新后台 `akari-panel/admin/` 的**验收清单**。每一行都要在新后台中可用，并有 Playwright e2e（桌面 + 手机两个项目）覆盖；e2e 用例名以行号开头（如 `USR-07`），`admin/e2e/` 里可按行号检索。
> 来源：① 面板后端的路由注册（`src/web.rs` 与各模块的 `routes()`，共 196 条，下面"附录 A"逐条对应）；② 旧后台 `spa/src/pages/admin-*.tsx`、`audit.tsx`、`admin-app.tsx` 的全部页面、对话框、筛选、批量操作、导出、设置；③ v0.4 新增功能（PLAN-v0.4 D1–D12、§5 中转、W27–W31、阶段 A 三个 PR 与 SPRINT 裁决）。
>
> 处理标记：**实现** = 新后台必须提供；**不迁移** = 后端已删除，新后台不做；**后端新增** = 本 PR 为后台补的小接口（在 PR 正文列出）；**仅命令行** = 有意不在后台提供（附理由）。

## 0. 不迁移（后端已删除）

| 编号 | 旧功能 | 理由 |
|---|---|---|
| X-01 | TOTP 两步验证（绑定、验证码登录、恢复码、"管理员必须两步验证"） | D7 移除，通行密钥取代 |
| X-02 | 手动分配节点 / 用户详情里的节点权限表、`GET /users/{id}/nodes` | D3 / D12 删除 |
| X-03 | 直接修改用户流量上限、到期时间、启用开关 | D12 只通过套餐；W28-c 用封禁取代"禁用" |
| X-04 | 一个节点多个入站的编辑器 | D2 一个节点一个入站 |
| X-05 | 门户与后台共用登录页、登录后从门户跳到后台 | D4：后台有自己的登录页（`/{前缀}/app`），门户不出现后台地址 |
| X-06 | 提现方式"支付宝 / 银行卡"等 | R46 只支持 USDT |
| X-07 | panel.toml 配置来源显示（`config`） | W25/R39 设置全部入库 |

## 1. 外壳、登录与通用交互

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| SH-01 | 后台登录页在 `/{前缀}/app`（独立的小打包，不含后台代码）；邮箱 + 密码登录；凭据错误统一提示 | `GET /auth/options`、`POST /auth/login` | D1/D4 | 实现 |
| SH-02 | 通行密钥登录（可发现凭据） | `POST /auth/passkey/options`、`/auth/passkey/login` | D7 | 实现 |
| SH-03 | "仅允许通行密钥登录（管理员）"开启时只显示通行密钥按钮，并提示命令行恢复 `akari admin reset-login` | `/auth/options`（`passkey_only_admins` 经设置） | D7 | 实现 |
| SH-04 | 密码登录后的"绑定通行密钥"引导（可稍后；可勾选"之后只用通行密钥"） | `passkey_prompt`、`/me/passkeys/options`、`POST /me/passkeys` | D7 | 实现 |
| SH-05 | 登录表单的蜜罐字段、最短提交时间令牌、Turnstile（登录开关开启时加载组件，CSP 仅在此时放行 challenges.cloudflare.com） | `/auth/options` 的 `guard` | W27 | 实现 |
| SH-06 | 非管理员账户在后台登录页登录：提示"不是管理员账户"并结束会话 | `/auth/logout` | 旧行为 | 实现 |
| SH-07 | 后台首页与资源只对管理员会话下发；无会话访问 `/{前缀}/admin*` = 规范 404（字节同构） | — | R23 | 实现（后端 + e2e） |
| SH-08 | 会话失效（401）自动回到登录页并带回原视图；退出登录 | `/auth/logout` | 旧行为 | 实现 |
| SH-09 | 可折叠侧边栏（记住选择）、分组导航、待处理计数（工单未读、正在告警） | `GET /admin-badges` | W33-a | 实现 |
| SH-10 | 顶栏：面包屑、搜索（Ctrl+K）、中/英切换、深/浅主题、告警铃铛、账户菜单 | — | W33-a | 实现 |
| SH-11 | 命令面板 Ctrl+K：跳转页面、常用操作（新建用户、添加节点、筛选从未使用的账号、测试发信、切换主题）、按邮箱找用户、按订单号找订单 | `GET /users?q`、`GET /orders?out_trade_no` | W33-a | 实现 |
| SH-12 | 视图即 URL（深链、后退可用），抽屉状态写入 URL | — | 旧行为 | 实现 |
| SH-13 | 中英双语（键齐全检查），所有服务端错误码映射 `errors.*`（`src/error_codes.txt` 全覆盖检查） | — | W21 + W33-b | 实现 |
| SH-14 | toast 反馈；确认框；危险操作写明影响数量，批量删除等需输入确认文字 | — | W33-a | 实现 |
| SH-15 | 加载骨架屏、空状态、错误状态（错误码 + 重试） | — | W33-a | 实现 |
| SH-16 | 手机可用：侧边栏变抽屉，表格变卡片列表，弹窗从底部弹出 | — | W33-a | 实现 |
| SH-17 | 日期时间按站点时区显示（来自接口 `timezone`，不再写死北京时间） | `/dashboard`、`/settings` | Q3 裁决 | 实现 |
| SH-18 | 页面标题 `<视图> · <站点名> 管理后台`，站点名、Logo、favicon 来自品牌设置 | `/auth/options` | W21 | 实现 |

## 2. 仪表盘

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| DSH-01 | 今日营收（含人工/赠送、退款）、订单数、注册数；用户总数、有效订阅、当前在线 | `GET /dashboard` | 旧 + W33-a | 实现 |
| DSH-02 | 服务器在线 / 总数 / 离线 / 停用 / 待注册 / 告警中 | 同上 | 旧 + Q1 | 实现 |
| DSH-03 | 近 14 天全网流量柱状图（站点时区的日）、流量最多的节点 | 同上 | W22 | 实现 |
| DSH-04 | 待处理：未回复工单、待审提现、失败邮件、已付款未开通订单、正在告警 —— 点击跳到对应页面并带筛选 | 同上 | 旧 | 实现 |
| DSH-05 | 最新订单（点击打开订单抽屉） | 同上 | 旧 | 实现 |
| DSH-06 | 有新 agent 版本时的提示徽章 | `GET /agent-updates` | 旧 | 实现 |
| DSH-07 | 自动刷新（30 秒） | — | 旧 | 实现 |

## 3. 系统状态（W31）

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| ST-01 | 每个面板实例：主机 CPU / 内存 / 负载 / 磁盘、进程内存、版本、运行时间、agent 会话数 | `GET /system/status` | 实现 |
| ST-02 | PostgreSQL、Valkey、反向代理（Caddy）状态与关键指标 | 同上 | 实现 |
| ST-03 | 后台任务：结算、对账、邮件、告警等的上次运行、耗时、延迟、是否停滞、最后错误、积压 | 同上 | 实现 |
| ST-04 | 有死信邮件时提示并可跳到"测试发信" | 同上 + 邮件设置 | 实现 |

## 4. 用户

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| USR-01 | 用户表：邮箱（未验证标记、所有者标记、已注销）、角色、状态徽章（正常/已到期/流量用尽/已封禁/已注销/无套餐）、套餐、流量进度、到期、注册时间 | `GET /users` | 旧 + D12 | 实现 |
| USR-02 | 搜索（邮箱 / ID 前缀，防抖）、状态筛选、套餐筛选、角色筛选、排序、分页与总数 | `GET /users?q&status&plan_id&role&sort&limit&offset` | 旧 | 实现 |
| USR-03 | "更多筛选"：从未使用 / 注册早于 / 最后登录早于（站点时区的日），筛选以小标签显示、可单独清除 | `never_used`、`registered_before`、`last_login_before` | D10 | 实现 |
| USR-04 | 列选择（记住选择）：可加显示最后登录、余额、通行密钥数等 | `GET /users`（**后端新增**行字段 `last_login_at`） | W33-a | 实现 + 后端新增 |
| USR-05 | 新建用户：邮箱（视为已验证）、密码、角色（管理员仅所有者可选）、可选套餐 + 周期 / 天数 | `POST /users` | D1/D12 | 实现 |
| USR-06 | 用户抽屉 · 当前订阅卡：套餐、周期、开始/到期、已用/总流量、重置方式、上次/下次重置（站点时区）、限速、状态 | `GET /users/{id}` | D12 | 实现 |
| USR-07 | 分配 / 更换套餐（套餐 + 周期或天数，说明从现在开始、用量清零） | `PUT /users/{id}/plan` | D12 | 实现 |
| USR-08 | 续期一个周期；延长 N 天（一次性套餐不显示） | `PATCH /users/{id}/plan` | D12 + 裁决④ | 实现 |
| USR-09 | 重置套餐流量（确认框说明会恢复因超流量停用的账户、写审计） | `POST /users/{id}/plan/reset-traffic` | D12 | 实现 |
| USR-10 | 取消套餐（确认） | `DELETE /users/{id}/plan` | 旧 | 实现 |
| USR-11 | 套餐历史（含周期、状态） | `GET /users/{id}/plan` | 旧 | 实现 |
| USR-12 | 封禁（原因必填，用户可见；说明立即踢线、订阅 404、写审计）/ 解除封禁；封禁抽屉显示原因、时间、操作人 | `POST /users/{id}/ban`、`/unban` | W28-c | 实现 |
| USR-13 | 修改角色（提升/降级；他人管理员与"设为管理员"仅所有者；有套餐不能提升） | `PATCH /users/{id}` `{role}` | R47 | 实现 |
| USR-14 | 设置新密码（结束该账户的会话） | `PATCH /users/{id}` `{password}` | 旧 | 实现 |
| USR-15 | 踢下线（结束全部会话） | `POST /users/{id}/revoke-sessions` | 旧 | 实现 |
| USR-16 | 查看并复制订阅链接（读取写审计）、二维码 | `GET /users/{id}/subscription` | W20 | 实现 |
| USR-17 | 重置订阅（新链接 + 新凭据，旧客户端全部失效；确认框说明） | `POST /users/{id}/sub-token` | 高-3 | 实现 |
| USR-18 | 标记邮箱已验证 | `POST /users/{id}/email/verify` | W24 | 实现 |
| USR-19 | 登录方式：通行密钥列表、是否仅通行密钥；"重置登录方式"（删除通行密钥、恢复密码登录） | `GET /users/{id}/passkeys`、`POST /users/{id}/login-method/reset` | W27 | 实现 |
| USR-20 | 转让所有者（仅所有者，目标为启用的管理员，输入确认） | `POST /users/{id}/owner` | R47 | 实现 |
| USR-21 | 删除用户：先显示影响（余额、可提现、待审提现、待付/未开通订单、有效套餐、是否匿名化保留），输入邮箱确认 | `GET /users/{id}/delete-impact`、`DELETE /users/{id}?confirm=true` | 中-7 | 实现 |
| USR-22 | 余额与明细；人工调整余额（带符号金额 + 原因） | `GET/POST /users/{id}/balance` | W16 | 实现 |
| USR-23 | 流量明细：每日折线（下载/上传/计费）+ 按节点表（API `group=node`） | `GET /users/{id}/traffic` | W22 | 实现 |
| USR-24 | 勾选（本页全选）→ 批量操作条；"对全部筛选结果批量操作" | — | Ops | 实现 |
| USR-25 | 批量操作：延长 N 天、重置流量、封禁（原因）、解封、分配/更换套餐、取消套餐、调整余额、发送邮件 —— 先预览人数与样例，再确认 | `POST /users/batch/preview`、`POST /users/batch` | Ops | 实现 |
| USR-26 | 批量任务列表：进度、明细（失败/跳过在前，错误码翻译）、取消 | `GET /users/batch`、`/users/batch/{id}`、`/cancel` | Ops | 实现 |
| USR-27 | 批量删除（勾选的 / 全部匹配的）：预览数量、管理员不删、匿名化数量、样例，输入"删除 N 个账户"确认 | `POST /users/delete/preview`、`/users/delete` | D10 + 裁决⑦ | 实现 |
| USR-28 | 导出 CSV（当前筛选） | `GET /users/export.csv` | Ops | 实现 |

## 5. 订单

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| ORD-01 | 订单表：订单号、用户、套餐/周期、类型、金额、优惠/余额/退款、方式（人工/赠送徽章）、状态、时间；"已付款但开通失败"顶部提示 | `GET /orders` | 旧 + W33-a | 实现 |
| ORD-02 | 筛选：状态（含已付款未开通、人工订单）、用户邮箱、订单号/交易号；加载更早（keyset） | `?status&email&out_trade_no&unfulfilled&via&before` | 旧 | 实现 |
| ORD-03 | 订单抽屉：金额拆分（原价 → 优惠券 → 换套餐抵扣 → 余额 → 实付）、支付事件、开通结果/错误、退款信息与撤销效果 | `GET /orders/{id}` | 旧 + P1 | 实现 |
| ORD-04 | 人工确认付款 / 重试开通（原因必填） | `POST /orders/{id}/fulfil` | 旧 | 实现 |
| ORD-05 | 退款：先取预览（将撤销的订阅效果），三种去向 ① 原路退回支付宝（可部分）② 退到余额 ③ 仅登记（已在商家平台手动退，填实际金额）；"仅退款、保留套餐"（默认不勾）；原因必填；输入订单号后 6 位确认；原路退款待确认（202）显示"处理中" | `GET /orders/{id}/refund-preview`、`POST /orders/{id}/refund` | P1 + 原路退款 | 实现 |
| ORD-06 | 自动退款（售罄 / 套餐停用 / 已另购）的订单可识别（退款原因显示） | `GET /orders/{id}` | 中-2 | 实现 |
| ORD-07 | 新建人工订单：按邮箱找用户 → 套餐 + 有价格的周期 → 赠送 / 原因（不传金额） | `POST /orders/manual` | Ops | 实现 |
| ORD-08 | 导出订单 CSV（日期范围、状态、方式） | `GET /orders/export.csv` | Ops | 实现 |

## 6. 优惠券

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| CPN-01 | 优惠券表：代码、类型/面值、已用/总次数、生效/失效、状态 | `GET /coupons` | 实现 |
| CPN-02 | 新建优惠券：代码、名称、比例/固定、适用套餐/周期、最低消费、时间窗、总次数、每人次数、仅新用户、启用 | `POST /coupons` | 实现 |
| CPN-03 | 详情：使用记录；修改次数、失效时间、名称等（代码不可改） | `GET/PATCH /coupons/{id}` | 实现 |
| CPN-04 | 启用 / 停用（确认）；删除（仅未使用） | `PATCH`、`DELETE /coupons/{id}` | 实现 |
| CPN-05 | 批量生成优惠码（前缀、数量 ≤5000、长度、条款、每码次数）；批次表；导出 CSV；作废批次 | `/coupon-batches*` | 实现 |

## 7. 资金

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| FIN-01 | 提现审核：筛选状态/邮箱；显示链、地址、Memo、申请金额（元）与参考 USDT | `GET /withdrawals` | 实现 |
| FIN-02 | 通过：填写实付 USDT 与交易哈希（备注可选）；拒绝：原因（退回余额） | `POST /withdrawals/{id}/approve`、`/reject` | 实现（R46） |
| FIN-03 | 用户余额列表、按邮箱查找任意用户；明细；人工调整 | `GET /balances`、`/users/{id}/balance` | 实现 |
| FIN-04 | 返利记录：筛选状态/邮箱 | `GET /commissions` | 实现 |
| FIN-05 | 邀请返利设置：开关、比例、仅首单、冻结天数、最低提现、可选 USDT 链（含 Plasma）、参考汇率 | `GET/PUT /commission-settings` | 实现（R46） |

## 8. 工单

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| TKT-01 | 工单队列：状态（未关闭/待回复/已回复/已关闭）、分类、优先级、负责人（我/未分配/某人）、只看未读、搜索、分页、计数 | `GET /tickets` | 实现 |
| TKT-02 | 工单会话（用户邮箱、作者）、回复、回复并关闭 | `GET /tickets/{id}`、`POST …/replies` | 实现 |
| TKT-03 | 关闭 / 重新打开；分配负责人 | `POST …/close`、`/reopen`、`PUT …/assignee`、`GET /admins` | 实现 |

## 9. 内容

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| CNT-01 | 公告列表；新建/编辑（中英标题与正文、受众、站点时区时间窗、置顶）；删除 | `/announcements*` | 实现 |
| CNT-02 | 公告邮件通知（选择受众） | `POST /announcements/{id}/mail` | 实现 |
| CNT-03 | 知识库分类：新建、改名（中/英）、排序、删除 | `/kb/categories*` | 实现 |
| CNT-04 | 知识库文章：新建/编辑（分类、中英标题与正文、排序、发布）、删除 | `/kb/articles*` | 实现 |
| CNT-05 | 正文编辑器旁的服务端渲染实时预览 | `POST /content/preview` | 实现 |
| CNT-06 | 服务条款 / 隐私政策：知识库固定 slug `terms`、`privacy` 的文章，后台可直接编辑（门户条款页读取它） | **后端新增**：文章 `slug` 字段（唯一，迁移 1080）；公开读取接口由门户 PR（W36-b）添加 | 实现 + 后端新增 |

## 10. 节点（服务器 → 落地节点 → 入口）

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| NOD-01 | 顶部统计：服务器在线、节点数、入口（直连/中转）、探测失败已隐藏的入口 | `GET /servers` | W33-a | 实现 |
| NOD-02 | 服务器卡片：名称、状态/在线、agent 版本/平台/协议（有新版本提示）、证书剩余、最后心跳、CPU/内存/速率、告警、警告、最后错误、租约 | `GET /servers` | Q1 | 实现 |
| NOD-03 | 新建服务器（名称、TLS 域名）→ 一次性安装命令（复制、倒计时）与手动引导文件 | `POST /servers` | Q1 | 实现 |
| NOD-04 | 重新生成安装命令；重新生成注册令牌 + 引导文件 | `POST /servers/{id}/install`、`/enroll-token` | 旧 | 实现 |
| NOD-05 | 编辑服务器：名称、TLS 域名（检查解析、改动前确认会重建）、计费速率上限 | `PATCH /servers/{id}`、`POST /inbound-templates/check-domain` | W10/W11 | 实现 |
| NOD-06 | 服务器流量额度（D5）：计费方式 双向/仅上行/仅下行、每周期额度、每月重置日、本周期已用；超额红色状态与说明；新额度高于已用时提示立即恢复 | `PATCH /servers/{id}` | D5 | 实现 |
| NOD-07 | 删除服务器（两阶段，输入名称确认）；删除中状态 | `DELETE /servers/{id}` | Q1 | 实现 |
| NOD-08 | 服务器详情：机器状态、延迟表（`<节点> / <入口>`）、立即测速（冷却提示）、历史曲线 1h–90d、节点原始/计费流量 | `/servers/{id}/status`、`/metrics`、`/probe` | W11 | 实现 |
| NOD-09 | 服务器告警规则覆盖：静音、关闭某些种类、各阈值 | `GET/PUT /servers/{id}/alert-rules` | W17 | 实现 |
| NOD-10 | 新建落地节点：选择服务器（或同时新建服务器）、名称、地区、协议模板（REALITY/Vision/SS2022/…，由 `protocols.toml` 生成的表单）或高级 JSON、检测 REALITY 目标、展示字段、直连入口设置 | `POST /nodes`、`/inbound-templates*` | W26 + D2 | 实现 |
| NOD-11 | 节点行：名称、协议、端口、启用、可见、审计规则开关；展开入口表 | `GET /servers` | D2 + W29 | 实现 |
| NOD-12 | 编辑节点：名称、显示名、地区、标签、排序、对用户显示；启用/停用（确认）；删除（确认） | `PATCH/DELETE /nodes/{id}` | W11 | 实现 |
| NOD-13 | 编辑节点入站：从模板替换或高级 JSON（端口冲突提示，协议变化会换凭据的说明） | `GET /nodes/{id}`、`PUT /nodes/{id}/inbound` | W28-a | 实现 |
| NOD-14 | 节点审计规则：节点级开关（关→开确认会重建入站），选择启用的规则集 | `GET/PUT /nodes/{id}/block-rules` | W29 + 裁决⑩ | 实现 |
| NOD-15 | 入口表：直连/中转、连接地址:端口、倍率（当前倍率、时段规则数、重叠警告）、节点组、TCP 探测（延迟/失败次数/时间）、订阅中（显示/已隐藏/已停用）、来源白名单状态（R44：已应用/待应用/失败） | `GET /servers` | §5 + R44 | 实现 |
| NOD-16 | 直连入口编辑：连接地址/端口、倍率、启用、排序、节点组 | `PATCH /entrances/{id}` | W28-a | 实现 |
| NOD-17 | 添加中转入口：名称、连接地址/端口、监听端口、中转机出口 IP/CIDR、倍率、启用、节点组；编辑；删除（输入入口名确认） | `POST /nodes/{id}/entrances`、`PATCH/DELETE /entrances/{id}` | §5 | 实现 |
| NOD-18 | 探测失败的入口：红色提示"已从订阅隐藏、已告警、恢复后自动显示" | `GET /servers` | §5 | 实现 |
| NOD-19 | 分时段倍率（D9）：基础倍率 + 规则（星期、起止时间、倍率）、站点时区、重叠警告、7×24 热力图、当前倍率 | `PUT /entrances/{id}/rate-rules` | D9 | 实现 |
| NOD-20 | 节点流量：每日折线 + 用量最高的用户 | `GET /nodes/{id}/traffic` | W22 | 实现 |
| NOD-21 | 节点组（套餐页"节点组"标签）：新建、改名/说明、选择入口（按服务器列出）、删除 | `/node-groups*` | W28-a | 实现 |

## 11. 套餐

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| PLN-01 | 套餐卡片：价格（各周期）、流量与重置、限速、节点组/入口数（含中转标记）、订阅人数/库存、在售/停用 | `GET /plans`、`/plan-prices` | 旧 + W33-a | 实现 |
| PLN-02 | 新建/编辑套餐（抽屉）：名称、说明、流量、限速、重置方式、节点组（实时列出用户将获得的入口）、库存、仅续费、下架后允许续费（renew_off_sale）、允许换入、排序、启用；各周期价格 + 上架 | `POST/PATCH /plans`、`PUT /plans/{id}/prices` | 中-2/中-6 | 实现 |
| PLN-03 | 修改条款时预览影响（订阅人数、会被立即暂停的人数），可选"同时应用到现有用户" | `POST /plans/{id}/impact`、`PATCH {apply_to_existing}` | 中-5 | 实现 |
| PLN-04 | 停用 / 启用（确认）；删除（仍有用户持有时提示） | `PATCH/DELETE /plans/{id}` | 旧 | 实现 |

## 12. 告警

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| ALR-01 | 告警列表：正在告警/已恢复、服务器、种类筛选、按种类计数、加载更早 | `GET /alerts` | 实现 |
| ALR-02 | 确认告警 | `POST /alerts/{id}/ack` | 实现 |
| ALR-03 | 告警设置：各阈值（留空 = 关闭）、Telegram（Bot token 只写、chat、API 地址）、签名 webhook（密钥只写、随机生成）、邮件收件人 | `GET/PUT /alerts/settings` | 实现 |
| ALR-04 | 各通道发送测试 | `POST /alerts/test` | 实现 |
| ALR-05 | 通知记录 + 重试 | `GET /alerts/notifications`、`POST …/{id}/retry` | 实现 |

## 13. 更新（agent 发布与灰度）

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| UPD-01 | 一键检查更新：检查、轮询状态、上次检查结果、发布源、自动检查开关；无发布公钥时禁用并说明 | `GET /agent-updates`、`POST …/check`、`PUT …/settings` | 实现 |
| UPD-02 | Agent 发布：列表；上传（manifest + 签名 + 二进制）；删除 | `/agent-releases*` | 实现 |
| UPD-03 | 灰度：新建（版本、比例、分批、健康超时、最大失败比例、可选服务器子集）；列表与每台服务器状态；暂停/继续/中止（只在合法状态显示） | `/rollouts*` | 实现 |

## 14. 审计日志

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| AUD-01 | 审计列表：时间、操作者（邮箱/标签）、动作（中英名称）、对象；按操作者、动作筛选；加载更早 | `GET /audit` | 实现 |
| AUD-02 | 字段级前后对比 | 同上 | 实现 |

## 15. 系统设置

| 编号 | 功能 | 接口 | 来源 | 处理 |
|---|---|---|---|---|
| SET-01 | 站点：站点名称、**站点时区**（IANA 名称，说明影响范围） | `PUT /settings/site` | Q3 | 实现 |
| SET-02 | 域名（D8）：主域名/订阅域名/节点通信域名三个列表、每类首选、DNS 检测、信任 Cloudflare、节点域名为 CF 时需强制、当前地址会被拒绝时需确认 | `GET/PUT /settings`、`POST /settings/dns-check` | D8/R22 | 实现 |
| SET-03 | 删除域名前列出影响（门户与后台、链接、待付订单、安装链接、订阅链接、节点），输入域名确认；首选不能直接删 | `POST /settings/domains/impact` | D8 | 实现 |
| SET-04 | 每个用户随机分配订阅域名（默认关） | `PUT /settings` `{sub_domain_per_user}` | D8 + 裁决① | 实现 |
| SET-05 | 节点通信证书域名表 + 移除（列出仍在用的服务器） | `POST /settings/server-names/remove` | R22 | 实现 |
| SET-06 | 后台地址（默认打码、可显示、复制）；轮换前缀（随机或自定义，显示新旧地址，输入"轮换"确认；仅所有者） | `GET /settings/access`、`POST …/admin-prefix` | D4/R47 | 实现 |
| SET-07 | 后台 IP 白名单（显示"你的地址"，不含自己时拒绝，附命令行恢复；仅所有者） | `PUT /settings/access/admin-allow` | D4/R47 | 实现 |
| SET-08 | 登录策略：仅通行密钥（管理员/用户分开）、密码登录后引导绑定 | `GET/PUT /settings/auth` | D7 | 实现 |
| SET-09 | 安全：审计/流量明细保留天数、Cloudflare 网段、额外信任的发布公钥 + 内置官方公钥（只读） | `PUT /settings/security` | W25 | 实现 |
| SET-10 | 订阅路径：修改（随机生成）、确认"旧链接全部失效"（输入确认）、可选邮件通知所有用户（默认勾选），显示通知任务 | `PUT /settings/access/sub-path` | D11 + 裁决⑥ | 实现 |
| SET-11 | 分流规则模板：规则表（geosite/geoip/域名/后缀/关键字/IP 段 × 直连/代理/拒绝）、增删、排序、恢复默认、规则集 URL 模板 | `PUT /settings/subscription` | W30 | 实现 |
| SET-12 | 订阅格式开关（Clash/mihomo、sing-box、通用链接）与门户一键导入按钮开关（Clash、Stash、Shadowrocket、sing-box、Hiddify） | 同上 | PR② §5 | 实现 |
| SET-13 | 注册：开放注册、需要验证邮箱、需要邀请码（独立开关）、邮箱域名白名单、每人邀请码数量、试用套餐/天数、找回密码 | `GET/PUT /settings/signup` | D1/W15 | 实现 |
| SET-14 | 人机验证：Turnstile 站点密钥 / 密钥（只写）、按表单开关（登录/注册/找回）、蜜罐、最短提交时间；警告显示 | `GET/PUT /settings/auth` | W27 | 实现 |
| SET-15 | 邮件发送：SMTP（主机、端口、465 隐式 TLS / 587 STARTTLS / 不加密、账号、密码只写）或 Resend（API key 只写）、发件人、通知开关（退款通知等） | `GET/PUT /settings/mail` | W31 | 实现 |
| SET-16 | 测试发信诊断：逐步显示（配置 → DNS → TCP → TLS → 问候 → 认证 → 发送），失败步骤标红并给出中英说明；直接发送测试邮件 | `POST /settings/mail/diagnose`、`/mail/test` | W31 | 实现 |
| SET-17 | 失败邮件（发件箱）：状态筛选、加载更早、重试死信 | `GET /mail/outbox`、`POST …/{id}/retry` | W15 | 实现 |
| SET-18 | 邮件模板：种类 × 语言、主题/正文编辑、占位符插入、未知占位符检查、iframe 实时预览、恢复默认（确认）、发送测试 | `/settings/mail-templates*` | Ops | 实现 |
| SET-19 | 支付方式：列表（类型、启用/不可用/停用、沙箱、排序）、添加（按类型 schema 生成表单，密钥可从文件读）、编辑（密钥留空不改）、测试连接、启停（确认）、删除（仅未被订单使用）、应用公钥复制、异步通知地址、"允许原路退款"开关 | `/settings/payments*` | W24/R40 | 实现 |
| SET-20 | 节点通信：安装命令公钥钉扎、备用下载地址/不使用备用、ACME 目录/邮箱、撤权方式（按用户 / 重建） | `PUT /settings/nodes` | W25 | 实现 |
| SET-21 | 测速：间隔、测速地址（1–4 个）、面板 TCP 测速开关 | `PUT /settings/probe` | W11 | 实现 |
| SET-22 | 审计规则（W29）：内置规则集与自定义规则集（域名/IP/协议）新建、编辑、开关、删除，近 7 天拦截次数，说明不记录访问明细 | `/block-rules*` | W29 | 实现 |
| SET-23 | 账号清理（D10）：自动清理（默认关）、天数 N、删除前邮件提醒与等待天数；上次运行结果、当前符合条件的数量并可跳到用户列表筛选 | `GET/PUT /settings/cleanup` | D10 | 实现 |
| SET-24 | 品牌：Logo / favicon 上传与删除、页脚文字与链接、服务条款/隐私链接、客户端下载链接 | `/settings/branding*` | Ops | 实现 |
| SET-25 | panel.toml 中已废弃的键横幅（`obsolete_config_keys`） | `GET /settings` | W25 | 实现 |

## 16. 我的账户

| 编号 | 功能 | 接口 | 处理 |
|---|---|---|---|
| ACC-01 | 账户信息（邮箱、所有者标记） | `GET /me` | 实现 |
| ACC-02 | 修改密码（当前密码 + 新密码） | `POST /me/password` | 实现 |
| ACC-03 | 通行密钥：列表（当前设备标记、最后使用）、添加、改名、删除；仅通行密钥登录开关（需至少一个） | `/me/passkeys*`、`PUT /me/password-login` | 实现 |
| ACC-04 | 退出登录 | `POST /auth/logout` | 实现 |

## 17. 仅后端 / 命令行（有意不在后台提供）

| 编号 | 功能 | 建议 |
|---|---|---|
| CLI-01 | `GET /metrics`（Prometheus） | 不暴露：独立监听端口，永不挂在 web 端口（M1-4） |
| CLI-02 | `GET /ask`（Caddy on-demand TLS 询问） | 不暴露：内部专用监听 |
| CLI-03 | `akari secrets rotate-jwt`（轮换会话签名密钥，所有人掉线） | 仅命令行：风险高、需要运维窗口 |
| CLI-04 | `akari settings unset admin-allow` / `unset turnstile`、`akari admin reset-login` | 仅命令行：这些是"被锁在外面"时的恢复手段，后台无法使用 |
| CLI-05 | `akari server enroll-token` | 后台已提供（NOD-04），命令行保留 |
| CLI-06 | 门户 `/me/*` 用户端点（商店、订单、工单、钱包等） | 门户功能，不属于后台（W36-b） |

## 18. 本 PR 的后端新增（小、带测试）

| 编号 | 内容 | 用于 |
|---|---|---|
| BE-01 | 后台登录页与后台应用的静态资源服务（`admin/dist/login` 在 `/{前缀}/app`，`admin/dist/console` 在 `/{前缀}/admin`，仅管理员会话），Turnstile 登录开启时登录页 CSP 放行 challenges.cloudflare.com | SH-01、SH-05、SH-07 |
| BE-02 | 用户列表行字段 `last_login_at` | USR-04 |
| BE-03 | 知识库文章 `slug`（唯一，迁移 1080；`terms` / `privacy` 供门户法律页使用），后台编辑 | CNT-06 |

## 附录 A：后端路由 → 清单编号

（`GET/POST/...` 均在后台前缀下；门户端点见 CLI-06）

| 路由 | 编号 |
|---|---|
| `POST /auth/login`、`/auth/logout`、`GET /auth/options` | SH-01、SH-06、SH-08、ACC-04 |
| `POST /auth/passkey/options`、`/auth/passkey/login` | SH-02 |
| `GET /me`、`POST /me/password` | ACC-01、ACC-02 |
| `GET/POST /me/passkeys`、`POST /me/passkeys/options`、`PATCH/DELETE /me/passkeys/{id}`、`PUT /me/password-login` | SH-04、ACC-03 |
| `GET /dashboard`、`GET /admin-badges` | DSH-*、SH-09 |
| `GET /system/status` | ST-* |
| `GET/POST /users`、`GET/PATCH/DELETE /users/{id}`、`GET /users/{id}/delete-impact` | USR-01…05、13、14、21 |
| `POST /users/{id}/revoke-sessions`、`/sub-token`、`GET /users/{id}/subscription` | USR-15、17、16 |
| `GET/PUT/PATCH/DELETE /users/{id}/plan`、`POST …/plan/reset-traffic` | USR-06…11 |
| `POST /users/{id}/ban`、`/unban` | USR-12 |
| `POST /users/{id}/email/verify` | USR-18 |
| `GET /users/{id}/passkeys`、`POST /users/{id}/login-method/reset` | USR-19 |
| `POST /users/{id}/owner` | USR-20 |
| `GET/POST /users/{id}/balance` | USR-22、FIN-03 |
| `GET /users/{id}/traffic` | USR-23 |
| `GET/POST /users/batch`、`POST /users/batch/preview`、`GET /users/batch/{id}`、`POST …/cancel` | USR-24…26 |
| `POST /users/delete/preview`、`/users/delete` | USR-27 |
| `GET /users/export.csv`、`/orders/export.csv`、`/traffic/export.csv` | USR-28、ORD-08、DSH-03（流量导出） |
| `GET /orders`、`GET /orders/{id}`、`POST /orders/{id}/fulfil`、`/refund`、`GET /orders/{id}/refund-preview`、`POST /orders/manual` | ORD-* |
| `GET/POST /coupons`、`GET/PATCH/DELETE /coupons/{id}`、`/coupon-batches*` | CPN-* |
| `GET /balances`、`/commissions`、`GET/PUT /commission-settings`、`GET /withdrawals`、`POST …/approve`、`/reject` | FIN-* |
| `GET /tickets`、`GET /tickets/{id}`、`POST …/replies`、`/close`、`/reopen`、`PUT …/assignee`、`GET /admins` | TKT-* |
| `/announcements*`、`POST /content/preview`、`/kb/categories*`、`/kb/articles*` | CNT-* |
| `GET/POST /servers`、`GET/PATCH/DELETE /servers/{id}`、`POST …/enroll-token`、`/install` | NOD-01…07 |
| `GET /servers/{id}/status`、`/metrics`、`POST /servers/{id}/probe` | NOD-08 |
| `GET/PUT /servers/{id}/alert-rules` | NOD-09 |
| `GET/POST /nodes`、`GET/PATCH/DELETE /nodes/{id}`、`PUT /nodes/{id}/inbound` | NOD-10…13 |
| `GET /inbound-templates`、`POST …/render`、`/check-dest`、`/check-domain` | NOD-05、10、13 |
| `GET/PUT /nodes/{id}/block-rules` | NOD-14 |
| `POST /nodes/{id}/entrances`、`PATCH/DELETE /entrances/{id}`、`PUT /entrances/{id}/rate-rules` | NOD-15…19 |
| `GET /nodes/{id}/traffic`、`GET /traffic/summary` | NOD-20、DSH-03 |
| `GET/POST /node-groups`、`PATCH/DELETE /node-groups/{id}` | NOD-21 |
| `GET/POST /plans`、`PATCH/DELETE /plans/{id}`、`POST /plans/{id}/impact`、`GET /plan-prices`、`PUT /plans/{id}/prices` | PLN-* |
| `GET /alerts`、`POST /alerts/{id}/ack`、`GET/PUT /alerts/settings`、`POST /alerts/test`、`GET /alerts/notifications`、`POST …/retry` | ALR-* |
| `/agent-releases*`、`/agent-updates*`、`/rollouts*` | UPD-* |
| `GET /audit` | AUD-* |
| `GET/PUT /settings`、`PUT /settings/site`、`POST /settings/dns-check`、`/domains/impact`、`/server-names/remove` | SET-01…05、25 |
| `GET /settings/access`、`POST …/admin-prefix`、`PUT …/admin-allow`、`PUT …/sub-path` | SET-06、07、10 |
| `GET/PUT /settings/auth` | SET-08、14 |
| `PUT /settings/security`、`/settings/nodes`、`/settings/probe`、`/settings/subscription` | SET-09、20、21、11、12 |
| `GET/PUT /settings/signup` | SET-13 |
| `GET/PUT /settings/mail`、`POST …/test`、`/diagnose`、`GET /mail/outbox`、`POST …/retry`、`/settings/mail-templates*` | SET-15…18 |
| `/settings/payments*` | SET-19 |
| `/block-rules*` | SET-22 |
| `GET/PUT /settings/cleanup` | SET-23 |
| `/settings/branding*`、`GET /brand/{name}` | SET-24 |
| `GET /healthz`、`/sub/{token}`、`/install/*`、`/pay/*`、`/me/*`（门户）、`/auth/register*`、`/auth/password-reset*` | 不属于后台（门户/公开路径） |
| `GET /metrics`、`GET /ask` | CLI-01、CLI-02 |
