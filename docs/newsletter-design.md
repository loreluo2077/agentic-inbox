# Newsletter 功能设计文档

> 状态：**待评审**（确认后再实现）
> 目标读者：本项目维护者
> 范围：为 `agentic-inbox` 新增「面向几万级订阅者的 newsletter 群发」能力，并向外部应用开放发送接口

---

## 1. 决策摘要

| 决策点 | 结论 |
|---|---|
| 订阅者规模 | **几万以上** → 必须引入 Cloudflare Queues 做投递流水线 |
| 外部应用接入 | **自建 API Key**（不依赖 Access Service Token） |
| 发送域名 | 已接入 Email Service 并完成 onboard → 可发给任意收件人 |
| 交付方式 | 先出设计文档（本文），评审通过后实现 |
| 发送粒度 | **每收件人一封**（个性化退订链接与变量替换；合规质量优先于配额节省） |
| 前端控制台 | **必做交付物**（活动列表、活动创建与预览、进度与失败明细、订阅者管理、API Key 管理），与后端同批交付，不是可选后期项 |

---

## 2. 现状约束（实现前必须知道的硬边界）

### 2.1 现有代码写死的约束

| 约束 | 位置 | 对 newsletter 的影响 |
|---|---|---|
| 生产环境唯一入口是 Cloudflare Access JWT，且 fail-closed | [workers/app.ts:46-81](../workers/app.ts#L46-L81) | 外部服务端应用**调不通**，必须开一条新路径 |
| 每邮箱发送限流 **20 封/小时、100 封/天** | [workers/durableObject/index.ts:793-817](../workers/durableObject/index.ts#L793-L817) | 群发第一次就会被 429；campaign 必须走**独立预算**，不能复用此限制 |
| 每次发送往该邮箱 `emails` 表插一行并进入 SENT | [workers/index.ts:187-202](../workers/index.ts#L187-L202) | N 个订阅者 = N 行，且 DO 单线程串行 → 收件箱 UI 会被冲垮。**campaign 记录必须另存** |
| 附件与邮件正文经 `storeAttachments` 落 R2 | [workers/lib/attachments.ts](../workers/lib/attachments.ts) | 可直接复用，无需改动 |
| 自定义 headers 已支持（`SendEmailParams.headers`） | [workers/email-sender.ts:56-58](../workers/email-sender.ts#L56-L58) | `List-Unsubscribe` 等合规头**无需改发送层** |

### 2.2 平台限额（官方文档，均为实测前必须尊重的数字）

**Email Service**（[Limits](https://developers.cloudflare.com/email-service/platform/limits/)、[Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)）

| 项 | 值 |
|---|---|
| 发给任意收件人 | 需要 **Workers Paid** 计划 |
| 出站计费 | 每月含 **3,000 封**，超出 **$0.35 / 1,000 封** |
| 每日发送配额 | **按账号**，新账号保守、随投递质量自动爬升；可[申请提额](https://forms.gle/eX6pXvit1wBv77Yw5) |
| 单封收件人合计 | ≤ 50（to+cc+bcc） |
| 单封总大小 | ≤ 5 MiB（已验证目标地址可 25 MiB） |
| 自定义头合计 | ≤ 16 KB |
| 硬退信 | **计入**配额 |
| 被抑制列表（suppression）在 API 边界拦截 | **不计入**配额 |
| 平台抑制列表 API | 批量导入 ≤ 1,000 条/次，≤ 10 次/分钟，分页 ≤ 1,000 |
| 出站投递在 Email Routing 汇总中显示为 `dropped` | 排查必须看 Email sending metrics/logs |

> **关键**：每日配额是**账号级**的，且会随信誉爬升。几万级群发的真正瓶颈不是 Queues 吞吐，而是**这个配额**。必须先按 §8 的预热与提额流程走。

**Queues**（[Limits](https://developers.cloudflare.com/queues/platform/limits/)）

| 项 | 值 |
|---|---|
| 消息大小 | 128 KB |
| 单次 `sendBatch` | ≤ 100 条（或合计 256 KB） |
| 消费端单批 | ≤ 100 条 |
| 单队列吞吐 | **5,000 条/秒** |
| 并发消费者调用 | **250**（push 模式） |
| 消费者墙钟时限 | 15 分钟/次 |
| 消费者 CPU | 默认 30 s，可配置至 5 分钟（`limits.cpu_ms`） |
| 消息重试 | 100 次 |
| 消息保留 | 可配置至 14 天 |
| 单队列积压 | 25 GB |

> Queues 的 5,000 msg/s 说明**流水线本身不是瓶颈**，瓶颈在 Email Service 日配额与域名信誉。

---

## 3. 总体架构

```
外部应用（服务端）
   │  Authorization: Bearer ain_<keyId>_<secret>
   ▼
POST /api/ext/v1/...            ┌─── Access Bypass 策略（按路径）───┐
   │                            │  /api/ext/*  → 由 API Key 保护    │
   │                            │  /unsubscribe* → 公开             │
   ▼                            └───────────────────────────────────┘
Hono (workers/app.ts)
   │
   ├─► ApiKeysDO（单例）                ── 校验 API Key / 作用域 / 限流
   │
   ├─► NewsletterDO（每邮箱一个）        ── subscribers / campaigns
   │        ▲                             campaign_recipients / daily_counters
   │        │
   │        └── 物化收件人 → 投递分片消息 ──► Queue: newsletter-send
   │                                              │
   │                                              ▼
   │                                    Queue consumer: send-worker
   │                                      · 领分片 → 读 recipients
   │                                      · 并发受限调用 env.EMAIL.send()
   │                                      · 回写 status + provider_message_id
   │                                      · 未发完 → re-enqueue 下一分片
   │
   └─► Queue: email-events ◄── Email Sending 事件订阅（按发送域名）
            delivered / deferred / bounced / failed / rejected / complained
              │
              ▼ consumer: events-worker
                更新 recipients + 抑制列表 + 订阅者状态
```

**为什么 campaign 不走 MailboxDO 的 `emails` 表**：一个 5 万人的 campaign 会在单个 DO 里产生 5 万行写入，且这些行会全部出现在用户的收件箱列表里。SENT 里只保留 **1 行 campaign 摘要**用于可见性，明细全部落在 `NewsletterDO`。

---

## 4. 外部应用接入：自建 API Key

### 4.1 Key 格式与存储

```
ain_<keyId(8字符base32)>_<secret(32字节 base64url)>
```

- **`keyId`** 明文存储并参与索引 → O(1) 查表，避免为比对哈希而全表扫描
- **`secret`** 只存 `SHA-256(secret)`（WebCrypto `crypto.subtle.digest`），**明文仅在创建时返回一次**
- 比对使用恒定时间比较，避免时序侧信道
- 展示用 `prefix`（`ain_ab12cd34…`）便于审计识别

存放位置：**独立单例 DO `ApiKeysDO`**（`idFromName("global")`），不用 KV——DO 读强一致，撤销立即生效。初期**不加 isolate 缓存**（DO 读只有毫秒级），等有性能数据再谈缓存与撤销延迟的取舍。

### 4.2 表结构

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,       -- keyId
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,          -- 展示用，如 ain_ab12cd34
  secret_hash   TEXT NOT NULL,          -- hex(SHA-256(secret))
  mailbox_ids   TEXT NOT NULL,          -- JSON 数组；["*"] 表示全部邮箱
  capabilities  TEXT NOT NULL,          -- JSON 数组，见下表
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,          -- 审计：谁创建的
  last_used_at  TEXT,
  expires_at    TEXT,                   -- 可空
  revoked_at    TEXT                    -- 可空
);

CREATE TABLE api_key_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     TEXT NOT NULL,
  ts         TEXT NOT NULL,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  request_id TEXT
);
```

### 4.3 能力（capability）模型

| capability | 允许 |
|---|---|
| `subscribers:read` | 读订阅者列表 |
| `subscribers:write` | 增删改、批量导入、退订 |
| `campaigns:read` | 读活动与统计 |
| `campaigns:write` | 建/改活动草稿 |
| `campaigns:send` | **触发群发**（高风险，按需授予） |
| `keys:admin` | 管理 API Key —— **默认不授予外部，且建议实现为仅 UI/Access 可用** |

> `keys:admin` 若可通过 API Key 获得，则一个泄漏的 Key 能自我提权/持久化。设计上**禁止**通过 `/api/ext/*` 授予或创建带 `keys:admin` 的 Key（只有 Access 保护的 UI/内部接口能创建 Key）。

### 4.4 中间件顺序（这是最容易踩坑的地方）

当前 `app.use("*")` 把 Access 校验套在所有路径上（[workers/app.ts:46-81](../workers/app.ts#L46-L81)）。**Access 在边缘生效，代码内的中间件也会拦一次**，所以只加 Bypass 策略还不够——必须同时改代码：

```ts
// workers/app.ts（示意）
const BYPASS_ACCESS = [/^\/api\/ext\//, /^\/unsubscribe/];

app.use("*", async (c, next) => {
  if (import.meta.env.DEV) return next();
  // 这些路径由 API Key / 签名 token 自行保护，不吃 Access
  if (BYPASS_ACCESS.some((re) => re.test(c.req.path))) return next();

  // ……原有 Access 校验逻辑保持不变……
});

// API Key 中间件只挂在 /api/ext/*
app.use("/api/ext/*", requireApiKey);
```

需要同步在 Cloudflare 控制台配置：对 `/api/ext/*` 与 `/unsubscribe*` 建 **Bypass** 策略。
**失效关闭（fail-closed）**：若 `POLICY_AUD`/`TEAM_DOMAIN` 未配置，应用仍应拒绝启动式地返回 500（保持现有行为），而不是因为路径豁免而裸奔。

### 4.5 Key 级限流与审计

- 每 Key 令牌桶（按分钟），计数存 `ApiKeysDO`；超限返回 `429` + `Retry-After`
- 所有 `/api/ext/*` 请求写 `api_key_usage`（含 `request_id`），便于事后追溯
- Key 轮换：支持同时存在新旧两把 Key，创建新 Key → 观察 `last_used_at` → 撤销旧 Key

---

## 5. 数据模型：`NewsletterDO`（每邮箱一个）

```sql
-- 订阅者
CREATE TABLE subscribers (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,      -- 统一小写
  name              TEXT,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|unsubscribed|bounced|complained|suppressed
  consent_source    TEXT,                      -- 来源：import/api/form/...
  consent_at        TEXT,                      -- 同意时间（GDPR/CASL 证据）
  consent_ip        TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,      -- 32 字节随机，不退订也能查
  provider_message_id_hint TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  unsubscribed_at   TEXT
);
CREATE INDEX idx_subscribers_status ON subscribers(status);

-- 活动
CREATE TABLE campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,                 -- 内部名
  subject       TEXT NOT NULL,
  html_template TEXT NOT NULL,
  text_template TEXT,
  from_name     TEXT,
  reply_to      TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|queued|sending|paused|sent|cancelled|failed
  total_count   INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  cursor        INTEGER NOT NULL DEFAULT 0,    -- 分片进度
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  created_by    TEXT
);

-- 收件人明细（campaign × subscriber）
CREATE TABLE campaign_recipients (
  id                  TEXT PRIMARY KEY,
  campaign_id         TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  email               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued', -- queued|sending|sent|failed|skipped|bounced|complained|unsubscribed
  attempts            INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,                     -- 用于与事件订阅关联
  error               TEXT,
  sent_at             TEXT,
  updated_at          TEXT NOT NULL,
  UNIQUE(campaign_id, subscriber_id)            -- 幂等键，重试安全
);
CREATE INDEX idx_recipients_campaign_status ON campaign_recipients(campaign_id, status);
CREATE INDEX idx_recipients_msgid ON campaign_recipients(provider_message_id);

-- 账号级每日预算（防撞平台日配额）
CREATE TABLE daily_counters (
  day          TEXT PRIMARY KEY,   -- UTC: 2026-10-08
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  hard_limit   INTEGER NOT NULL    -- 人工配置的每日上限（低于平台配额，留余量）
);
```

**数据保留策略**：每周一次 5 万人的 campaign → 每年 ~260 万行 `campaign_recipients`（约 300–500 MB）。需加定期归档任务：明细保留 90 天，之后只保留按活动的聚合统计。DO SQLite 单对象上限充足，但不清理会持续膨胀。

---

## 6. 接口契约

### 6.1 外部 API（`/api/ext/v1/*`，API Key 保护）

统一响应：成功 `2xx` + JSON；失败 `{ "error": "..." }` + 语义化状态码。所有写操作带 `Idempotency-Key` 头（缺失时按请求体哈希兜底）。

| 方法 & 路径 | 说明 |
|---|---|
| `GET /api/ext/v1/mailboxes` | 列出该 Key 有权访问的邮箱 |
| `POST /api/ext/v1/mailboxes/:mailboxId/subscribers/import` | 批量导入（≤1,000 条/次，与平台抑制列表限制对齐）；返回 `{added, updated, skipped, errors[]}` |
| `GET /api/ext/v1/mailboxes/:mailboxId/subscribers?status=&cursor=&limit=` | 游标分页 |
| `DELETE /api/ext/v1/mailboxes/:mailboxId/subscribers/:id` | 退订（软删，写 `unsubscribed_at`） |
| `POST /api/ext/v1/mailboxes/:mailboxId/campaigns` | 建活动草稿（subject + html/text 模板） |
| `PATCH /api/ext/v1/mailboxes/:mailboxId/campaigns/:cid` | 改草稿（仅 `draft` 状态可改） |
| `POST /api/ext/v1/mailboxes/:mailboxId/campaigns/:cid/send` | **触发群发**：物化收件人 + 入队；返回 `202 {campaignId, totalCount}` |
| `POST /api/ext/v1/mailboxes/:mailboxId/campaigns/:cid/pause` | 暂停（消费者停止取新分片） |
| `POST /api/ext/v1/mailboxes/:mailboxId/campaigns/:cid/resume` | 恢复 |
| `GET /api/ext/v1/mailboxes/:mailboxId/campaigns/:cid` | 进度与统计 |

**示例**

```bash
curl -X POST "https://inbox.example.com/api/ext/v1/mailboxes/news@example.com/campaigns/01J.../send" \
  -H "Authorization: Bearer ain_ab12cd34_XXXXXXXXXXXXXXXXXXXXXXXX" \
  -H "Idempotency-Key: 7f3c-a91e"
```

### 6.2 公开退订（`/unsubscribe`，无鉴权，Access Bypass）

| 方法 | 说明 |
|---|---|
| `GET /unsubscribe?token=<opaque>` | 展示确认页；**不泄漏 token 是否存在** |
| `POST /unsubscribe?token=<opaque>` | RFC 8058 一键退订（body `List-Unsubscribe=One-Click`），始终返回 200 |

要求：幂等；快速返回（可 `waitUntil` 异步落库）；退订后该订阅者此后所有 campaign 一律 `skipped`。

### 6.3 模板变量

```
{{name}} {{email}} {{unsubscribe_url}} {{campaign_id}}
```

渲染用字符串替换即可（几万级下开销可忽略）。**未转义规则**：`{{name}}` 必须 HTML 转义后插入，避免订阅者姓名成为注入点。

---

## 7. 投递流水线

### 7.1 阶段一：物化（trigger 阶段）

1. 校验 campaign 状态为 `draft`
2. 选出目标订阅者：`status='active'` 且不在抑制列表
3. 以 500 行/语句、`storage.transactionSync` 分批写入 `campaign_recipients`（5 万行 = 100 条语句）
4. 把 `total_count` 写入 campaign，状态改 `queued`
5. 投递**分片消息**（不是每人一条）：`{ campaignId, mailboxId, cursor: 0 }`

> 为什么不给每个收件人发一条队列消息：5 万条消息会产生 5 万次写 + 5 万次读操作，且消费者需要反复回 DO 取模板。分片消息（每片 200 人）只有 250 条消息，消息体小，重试粒度也够用。

### 7.2 阶段二：发送（Queue consumer）

```
领取分片 {campaignId, cursor}
  ├─ campaign.status ∈ {queued, sending}?  否则直接 ack（暂停/取消）
  ├─ 检查 daily_counters：预算是否耗尽？
  │     耗尽 → re-enqueue 同分片，delaySeconds = 到次日 UTC 0 点
  ├─ 从 DO 取该分片 200 行 recipients（status='queued'）
  ├─ 取 campaign 模板，逐人渲染（HTML 转义 + 个性化退订链接）
  ├─ 并发受限发送（建议 20 并发 / 片）
  │     env.EMAIL.send({ to, from, subject, html, text, headers })
  │     headers: { 'List-Unsubscribe': '<https://.../unsubscribe?token=...>',
  │                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  ├─ 回写：status='sent'、provider_message_id、sent_at；失败写 error+attempts
  ├─ daily_counters.sent_count += 成功数
  └─ 若还有剩余 → re-enqueue {cursor: cursor + 1}
```

**必须尊重的边界**

| 边界 | 数值 | 设计对策 |
|---|---|---|
| Workers Paid 单次调用子请求上限 | 1,000（实施前请按当前 Workers 限额复核） | 分片 ≤ 200 人，一次调用内子请求数远低于上限 |
| Queues 单批 ≤ 100 条 | 100 | 一个分片消息 = 一个批次处理对象，与批大小无关 |
| 消费者 CPU 默认 30 s | 30 s | 发送是 I/O 密集，CPU 时间极低；必要时用 `limits.cpu_ms` 提高 |
| 消费者墙钟 15 min | 15 min | 200 人 / 20 并发 ≈ 十秒级，安全 |
| 单封 5 MiB / 头 16 KB | — | 建活动时校验模板与附件体积，超限直接 `400` |
| Email 日配额 | 账号级 | `daily_counters.hard_limit` 人工设低于平台配额（留 20% 余量），耗尽即顺延到次日 |

### 7.3 阶段三：事件回填（Email Sending 事件订阅）

事件订阅按**发送域名**维度配置，事件类型（[官方文档](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)）：

| 事件 | 处理 |
|---|---|
| `cf.email.sending.message.delivered` | `recipients.status='sent'`（终态确认） |
| `cf.email.sending.message.deferred` | 记 `events`，不定为失败 |
| `cf.email.sending.message.bounced` | 硬退 → `status='bounced'`，写平台抑制列表，订阅者置 `bounced` |
| `cf.email.sending.message.failed` | `status='failed'`（可重试） |
| `cf.email.sending.message.rejected` | 若 `rejection.reason === 'suppressed'` → 订阅者置 `suppressed`（**此类不计配额**） |
| `cf.email.sending.message.complained` | **立即**抑制 + 订阅者置 `complained`；投诉率高会毁掉域名信誉 |

关联方式：事件带 `messageId` 与 `recipient`，通过 `campaign_recipients.provider_message_id`（已建索引）定位到具体收件人。**因此 `env.EMAIL.send()` 返回的 `messageId` 必须落库**——这也是 §7.2 回写步骤不能省的原因。

---

## 8. 域名预热、配额与合规

### 8.1 预热与提额（几万级的头等大事）

1. **用独立发送子域**（如 `news.example.com`）——把 newsletter 信誉与事务性邮件隔离，出问题不影响主域
2. 先发**最小 campaign**（1,000–2,000 封），观察 delivered / hard bounce / complaint
3. 硬退信率 < 2%、投诉率 < 0.1% 时，**按天翻倍**爬坡
4. 目标量需要更高配额时，尽早提交[提额申请](https://forms.gle/eX6pXvit1wBv77Yw5)——自动爬升可能跟不上你的排期
5. 配置 SPF/DKIM/DMARC（[Email authentication](https://developers.cloudflare.com/email-service/concepts/email-authentication/)）与 MTA-STS

### 8.2 合规清单

- [x] 每封带 `List-Unsubscribe` + `List-Unsubscribe-Post`（一键退订，RFC 8058）
- [x] 退订即时生效（`unsubscribed_at` 落库 + 平台抑制列表）
- [x] 记录同意证据（`consent_source` / `consent_at` / `consent_ip`）
- [x] 提供数据导出与删除（GDPR 撤回同意权）
- [ ] 邮件正文包含发件人真实身份与邮寄地址（CAN-SPAM 要求）
- [ ] 主题行不得误导（CAN-SPAM）
- [ ] 投诉/退信自动抑制，不再打扰

### 8.3 成本估算

Email 侧（Workers Paid 每月含 3,000 封，超出 $0.35/1,000）：

| 月发送量 | 计费量 | Email 费用 |
|---|---|---|
| 50,000 | 47,000 | ≈ **$16.45/月** |
| 200,000 | 197,000 | ≈ **$68.95/月** |
| 500,000 | 497,000 | ≈ **$173.95/月** |

另加 Workers Paid 基础费 $5/月；Queues 与 DO 存储相对可忽略（以[官方定价页](https://developers.cloudflare.com/queues/platform/pricing/)为准）。
**注意**：硬退信也计费；被抑制列表在 API 边界拦下的**不计费**。

---

## 9. 对现有代码的改动清单

| 文件 | 改动 |
|---|---|
| `wrangler.jsonc` | 新增 `NEWSLETTER` DO 绑定 + migration tag `v4`；新增 `newsletter-send` 生产者/消费者绑定、`email-events` 消费者绑定 |
| `workers/app.ts` | 导出 `NewsletterDO`、`ApiKeysDO`；Access 中间件加路径豁免；挂载 `/api/ext/*`（API Key）与 `/unsubscribe*`（公开）；`default export` 增加 `queue(batch, env, ctx)` 处理两个队列 |
| `workers/routes/newsletter-ext.ts` | **新增**：外部 API 全部端点 |
| `workers/routes/unsubscribe.ts` | **新增**：公开退订页与一键退订 |
| `workers/lib/api-keys.ts` | **新增**：生成、哈希、校验、作用域判定、限流、审计 |
| `workers/lib/newsletter.ts` | **新增**：模板渲染、分片计算、发送循环、头部拼装 |
| `workers/durableObject/newsletter/{index,schema,migrations}.ts` | **新增**：`NewsletterDO` |
| `workers/durableObject/apikeys/{index,schema,migrations}.ts` | **新增**：`ApiKeysDO` |
| `workers/queue/{send-consumer,events-consumer}.ts` | **新增**：两个消费者 |
| `workers/email-sender.ts` | **不改**（已支持自定义 headers 与 attachments） |
| `workers/durableObject/index.ts` 的 `checkSendRateLimit` | **不改**（保持邮箱手动发送的 20/100 保护），campaign 走 `daily_counters` 独立预算 |
| `app/routes.ts` | 新增 `newsletter` 嵌套路由（5 个页面） |
| `app/routes/newsletter*.tsx` | **新增**：5 个页面路由（活动列表 / 新建活动 / 活动详情 / 订阅者 / 设置） |
| `app/components/newsletter/*.tsx` | **新增**：见 §12.4 组件清单 |
| `app/queries/newsletter.ts` | **新增**：查询与变更 hooks |
| `app/queries/keys.ts` | 新增 `newsletter.*` 键工厂 |
| `app/services/api.ts` | 新增 newsletter 端点方法 |
| `app/types/index.ts` | 新增 `Campaign` / `Subscriber` / `ApiKey` / `NewsletterSettings` / `CampaignStats` |
| `app/components/Sidebar.tsx` | 新增「NEWSLETTER」分组入口 |
| `app/components/RichTextEditor.tsx` | 视 §13 第 6 问决定是否补齐 Color/Highlight/Align/Image 工具栏接线 |

**测试**：仓库当前**零测试**。本功能的合规与幂等逻辑（token 签名/校验、HTML 转义、分片边界、幂等键、预算扣减）属高风险纯函数，建议同时引入最小测试框架（Vitest）覆盖这些函数——否则合规逻辑只能靠线上试错。

---

## 10. 分阶段实施计划

每个阶段都**同时交付后端与页面**（页面不是末尾的独立阶段）：

> **实施状态**：**P0 已实现并端到端验证**（见 §10.1）。P1 起未开始。

| 阶段 | 后端 | 页面 | 验收标准 |
|---|---|---|---|
| **P0 接入层** | `ApiKeysDO` + `requireApiKey` + Access 路径豁免 + Key 管理接口 | Newsletter 设置页的 **API Key 管理**（创建→一次性明文→列表→撤销） | 外部应用用 Bearer Key 调通只读接口；无 Key 401；Key 撤销立即失效；**页面能独立完成一轮 Key 生命周期** |
| **P1 数据层** | `NewsletterDO` + 订阅者导入/查询/退订 + 公开退订页 | **订阅者管理页**（列表、搜索、状态过滤、导入 Dialog、退订） | 导入 5 万条成功（分批、可续传）；退订链接可用且落库；页面能看到导入分类结果 |
| **P2 单活动群发** | campaign 创建 + 物化 + 队列分片投递 + 每日预算 | **活动列表 + 新建活动（含 EmailIframe 实时预览）+ 发送前确认** | 向 2,000 个测试订阅者完整群发；进度可查；重复触发不重复发；**全程可在 UI 完成，不依赖 curl** |
| **P3 投递质量** | 事件订阅消费者 + 退信/投诉抑制 + 统计接口 | **活动详情页**（进度、计数、失败明细、暂停/恢复）+ 配额仪表 | 硬退信自动抑制、`complained` 立即抑制；统计与平台 metrics 对得上；页面可见 |
| **P4 规模化** | 域名预热脚本/清单、提额申请 | 大规模活动的进度性能（5 万行轮询不卡） | 单活动 5 万封完成，硬退信率 < 2%、投诉率 < 0.1% |

### 10.1 P0 实施记录（已完成）

已交付：`ApiKeysDO`（SQLite + 迁移）、`workers/lib/api-keys.ts`、`/api/v1/api-keys` 管理接口、`/api/ext/v1/*` 外部接口、Access 路径豁免、Newsletter 页面外壳 + Sidebar 入口 + API Key 管理页、Vitest 基础设施。

验证结果（本地 dev server，真实 DO/R2）：

| 用例 | 结果 |
|---|---|
| `GET /api/v1/api-keys`（空库） | 200，返回可用能力清单 |
| `POST /api/v1/api-keys` | 201；**客户端请求 `keys:admin` 被静默丢弃**，仅保留合法能力 |
| `GET /api/ext/v1/whoami`（正确 Key） | 200 |
| 无 Authorization | 401 + 明确错误信息 |
| 篡改 secret | 401 `Invalid API key` |
| `GET /api/ext/v1/mailboxes`（按作用域过滤） | 200 |
| `DELETE /api/v1/api-keys/:id` | 204 |
| **撤销后立即再用同一 Key** | 401 `API key has been revoked`（无缓存延迟） |
| 限流（120/分钟） | 第 121 个请求起 429，带 `Retry-After`；130 次请求 = 120×200 + 10×429 |
| 审计字段 | `lastUsedAt` / `revokedAt` / `createdBy` 均正确落库 |

自动化检查：`npm run typecheck` 退出码 0；`npm test` 28 项全部通过；`npm run build` 退出码 0。

**仍需人工完成（代码之外）**：在 Cloudflare 控制台为 `/api/ext/*` 与 `/unsubscribe*` 添加 Access Bypass 策略，否则生产环境的外部调用会在边缘被 Access 拦下。本地开发因 `import.meta.env.DEV` 跳过 Access，无法验证这一环。


---

## 11. 风险与未决问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| **账号日配额卡死排期** | 几万级首发必然撞上保守配额 | P5 提前提额；`daily_counters.hard_limit` 顺延而非失败 |
| **域名信誉受损** | 投诉率/硬退信率过高会拖垮整个域 | 独立子域 + 预热 + 投诉立即抑制 |
| **Access Bypass 配置错误** | 可能把 `/api/ext/*` 暴露成完全公开 | 代码 fail-closed：无 Key 一律 401；上线前用无凭证 curl 验证 |
| **`keys:admin` 提权** | 一个泄漏的 Key 若可管理 Key 则可持续化 | 该能力禁止通过 `/api/ext/*` 授予 |
| **DO 单线程写入瓶颈** | 5 万行物化集中在一次触发里 | 分批事务；必要时把物化也拆成队列任务 |
| **事件与收件人关联失败** | 事件只有 `messageId`，未落库则无法关联 | `provider_message_id` 强制落库 + 索引；关联失败落 `events` 待查 |
| **未决：点击/打开追踪** | 需要追踪域与隐私政策 | 本期不做；若要做需单独评审 |
| **未决：多租户 Key 粒度** | 目前按 `mailbox_ids` 授权，未来若要按活动授权需扩展 | P0 先支持 `mailbox_ids` + capability |

---

## 12. 页面（前端控制台）设计

> 本章为**必做范围**。所有阶段的后端都配套页面交付（见 §10）。

### 12.1 在现有应用中的位置

- 挂在现有 mailbox 路由之下：`/mailbox/:mailboxId/newsletter/*`
  → 自动复用 Access 保护，以及「Sidebar + Header + Outlet」外壳（[app/routes/mailbox.tsx](../app/routes/mailbox.tsx)）
- Sidebar 在 `FOLDERS` 分组下方新增独立分组 **NEWSLETTER**，三个入口：Campaigns / Subscribers / Settings
- Header 不改（全局邮箱搜索与 newsletter 无关）；右侧 Agent 面板不受影响

### 12.2 路由

`app/routes.ts` 扩展（沿用现有嵌套风格）：

```ts
route("mailbox/:mailboxId", "routes/mailbox.tsx", [
  index("routes/mailbox-index.tsx"),
  route("emails/:folder", "routes/email-list.tsx"),
  route("settings", "routes/settings.tsx"),
  route("search", "routes/search-results.tsx"),
  route("newsletter", "routes/newsletter.tsx", [          // 布局 + 子导航
    index("routes/newsletter-campaigns.tsx"),              // 活动列表
    route("campaigns/new", "routes/newsletter-campaign-new.tsx"),
    route("campaigns/:campaignId", "routes/newsletter-campaign-detail.tsx"),
    route("subscribers", "routes/newsletter-subscribers.tsx"),
    route("settings", "routes/newsletter-settings.tsx"),
  ]),
])
```

**页面状态全部进 URL**：tab 由嵌套路由决定，campaign id 是路径参数，分页用 `?page=`。（现有邮件列表把选中邮件与分页放在内存里，见 §12.9 —— 新页面刻意不沿用。）

### 12.3 页面清单

| 页面 | 路径 | 内容 | 关键交互 |
|---|---|---|---|
| **活动列表** | `…/newsletter` | 表格：名称 / 主题 / 状态 / 进度 / 已发 / 失败 / 创建时间；顶部「今日配额」仪表 | New campaign；状态过滤；行内 Pause / Resume / Cancel / 复制为草稿 |
| **新建活动** | `…/newsletter/campaigns/new` | 名称、Subject、From name、Reply-To、正文编辑器、变量插入、右侧实时预览、收件人范围 | 变量按钮插入 `{{name}}` 等；预览走沙箱 iframe；发送前检查清单 |
| **活动详情** | `…/newsletter/campaigns/:campaignId` | 进度条 + 分类计数卡（queued / sent / failed / skipped / bounced / complained）+ 失败明细表 | 仅进行中时轮询；Pause / Resume / Cancel；导出失败列表 |
| **订阅者** | `…/newsletter/subscribers` | 表格：email / name / 状态 / 来源 / 同意时间；状态过滤 + 搜索 + 游标分页 | Import Dialog；单个退订（乐观更新）；导出 |
| **Newsletter 设置** | `…/newsletter/settings` | 发送配置（From name、Reply-To、每日上限 `hard_limit`、发送子域说明）+ API Key 管理 + 合规检查清单 | 创建 Key → 一次性明文 → 列表 → 撤销 |

### 12.4 组件清单（新增于 `app/components/newsletter/`）

| 组件 | 职责 |
|---|---|
| `NewsletterTabs.tsx` | 子导航（Campaigns / Subscribers / Settings），用 `NavLink` 驱动 URL |
| `CampaignTable.tsx` + `CampaignStatusBadge.tsx` | 活动列表与状态徽标（复用 Kumo `Badge`） |
| `CampaignComposer.tsx` | 表单编排：字段校验、变量插入、脏检查、保存草稿 |
| `CampaignPreview.tsx` | 用 **`EmailIframe`** 渲染预览（复用现有沙箱安全模型，不新造一条 HTML 渲染路径） |
| `CampaignProgressCard.tsx` | 进度条 + 分类计数（纯 CSS，不引图表库） |
| `RecipientFailureTable.tsx` | 失败 / 退信明细 |
| `SubscriberTable.tsx` | 订阅者表格、过滤、分页 |
| `SubscriberImportDialog.tsx` | 粘贴或上传 CSV → 解析 → 分类结果展示 |
| `ApiKeyManager.tsx` / `ApiKeyCreateDialog.tsx` / `RevealOncePanel.tsx` | Key 生命周期；明文仅显示一次 + 复制 / 下载 |
| `QuotaMeter.tsx` | 今日已发 / 上限（来自 `daily_counters`）、剩余可发量 |
| `ConfirmSendDialog.tsx` | 发送前二次确认：收件人数、预计配额消耗、预计耗时、被排除人数 |

### 12.5 数据层

- `app/services/api.ts`：新增 newsletter 端点方法（沿用现有 `get/post/put/del` 与 `ApiError`）
- `app/queries/keys.ts` 新增键工厂：

```ts
newsletter: {
  campaigns:   (mailboxId)         => ["newsletter", mailboxId, "campaigns"] as const,
  campaign:    (mailboxId, id)     => ["newsletter", mailboxId, "campaign", id] as const,
  subscribers: (mailboxId, params) => ["newsletter", mailboxId, "subscribers", params] as const,
  settings:    (mailboxId)         => ["newsletter", mailboxId, "settings"] as const,
  apiKeys:     ()                  => ["newsletter", "apiKeys"] as const,
  quota:       (mailboxId)         => ["newsletter", mailboxId, "quota"] as const,
}
```

- **轮询策略**：仅当 campaign 状态 ∈ `{queued, sending}` 时启用 `refetchInterval: 3000`；终态一律停止轮询（不沿用邮件列表「常驻 30s 轮询」的做法）
- **失效策略**：所有 mutation 明确失效 `["newsletter", mailboxId]` 前缀；发送 / 暂停 / 恢复额外失效 `campaign(id)` 与 `quota`
- **乐观更新**：订阅者退订做乐观更新 + 失败回滚 + toast；活动状态类操作**不做**乐观更新（有真实进度，以服务端为准）

### 12.6 关键交互细节

- **发送不可撤销**：必须经 `ConfirmSendDialog`，展示收件人数、预计配额消耗、预计耗时与「将被排除的人数」；要求输入活动名二次确认
- **配额不足时**：明确提示「今日配额已用 X/Y，剩余部分将在次日 UTC 0 点自动继续」，并给设置页入口 —— 而不是静默失败
- **导入结果分类**：新增 / 更新 / 重复 / 无效邮箱 / 已在抑制列表，逐类给出数量与可下载明细
- **API Key 明文只显示一次**：`RevealOncePanel` 突出「关闭后无法再次查看」，提供复制与下载
- **空态区分三种**：还没有活动 / 还没有订阅者 / 过滤后无结果（可参考现有 `FOLDER_EMPTY_STATES` 的做法）
- **破坏性操作统一用 Kumo Dialog**，不使用 `window.confirm`

### 12.7 复用与新增依赖

**复用**：`RichTextEditor`、`EmailIframe`（模板预览，天然沙箱）、Kumo 组件（`Badge` / `Button` / `Dialog` / `Input` / `Loader` / `Tooltip` / `Pagination` / `useKumoToastManager`）、TanStack Query 约定与 query key 工厂、`formatBytes` 等工具函数。

**新增依赖：0 个。**
- 统计用纯 CSS 进度条 + 数字卡，不引图表库
- CSV 解析自行实现（按行 + 引号/逗号转义），不为一个导入功能引入依赖

### 12.8 加载 / 错误 / 空 状态

- **必须实现 `isError` 分支**：现有前端全站没有 `isError` 处理，加载失败与加载中无法区分（永远停在骨架屏）—— 新页面每个 query 都要有错误态 + 重试按钮
- 骨架屏沿用现有 Skeleton 风格，避免布局跳动
- 5 万行规模：后端游标分页 + 前端分页，**绝不一次渲染 5 万行**

### 12.9 一致性：刻意规避现有前端的已知问题

| 现有问题 | 新页面的做法 |
|---|---|
| 选中邮件与分页不入 URL（无法分享、后退不关面板） | campaign id 与 `?page=` 全部入 URL |
| 搜索结果缓存从不失效（点开已读也不更新） | 所有 mutation 明确失效 `["newsletter", ...]` 前缀 |
| 删除无乐观更新、失败只 `console.error`（用户无感） | 退订乐观更新 + 回滚 + toast；失败必有提示 |
| 全站无 `isError` 分支 | 每个 query 都有错误态与重试 |
| 5 处 `window.confirm` / `window.prompt` | 统一用 Kumo Dialog |
| 无 `loader`/`action`，SSR 只出骨架 | 沿用该约定（客户端 TanStack Query），不引入第二套数据获取模式 |
| 移动端 Agent 面板不可用（`hidden lg:flex`） | 表格横向滚动 + 小屏卡片降级；Tabs 可横滑 |

**文案语言**：现有界面全英文，Newsletter 页面默认沿用英文以保持一致；若需要中文，需另加 i18n 层（现有代码没有 i18n 基础设施，属额外工作量）。

### 12.10 权限

- 页面位于 mailbox 路由内 → 受 Cloudflare Access 保护，与现有页面同级
- **只有本页面（经 Access）能创建 / 撤销 API Key**；`keys:admin` 不可通过 `/api/ext/*` 获得（见 §4.3）

---

## 13. 评审问题（请确认）

1. 发送粒度确认为**每收件人一封**（个性化退订链接）？还是允许「一封最多 50 人」以省配额？
2. `campaign_recipients` 明细保留 **90 天**是否合适？
3. 是否需要**点击 / 打开追踪**（会引入追踪域与隐私合规要求）？
4. 阶段顺序按 §10 的 **P0→P4**（每阶段后端 + 页面一起交付）是否 OK？
5. 是否同意同时引入 **Vitest**，覆盖 token 校验 / HTML 转义 / 分片边界 / 幂等 / 预算扣减等合规关键纯函数？
6. 活动正文编辑器：**扩展现有 `RichTextEditor` 工具栏**（补 Color/Highlight/Align/Image 接线，可顺带修复邮件撰写里"装了但没接线"的能力）还是 newsletter 用原始 HTML + 预览？
7. Newsletter 入口：**Sidebar 独立分组**（推荐）还是并入现有 Settings 页？
8. 页面文案：沿用**英文**（推荐，与现有界面一致）还是需要中文 i18n？
