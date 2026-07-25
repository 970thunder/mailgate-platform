# MailGate 虚拟邮箱运营平台

生产化版本采用 `React + Express + PostgreSQL + Redis + Worker`，区分临时域名邮箱与真实邮箱，支持钱包计费、软删除、管理员运营数据和自动释放。

## 启动

```bash
cp .env.example .env
# 为所有密钥替换为随机安全值；ENCRYPTION_KEY 必须为 64 位十六进制字符
docker compose up -d --build
```

`api` 会自动执行数据库迁移，再启动 HTTP 服务。默认地址为 `http://localhost:3001`。本地前端热更新可运行 `npm run dev:web`；本地 API 与 worker 分别使用 `npm run dev:api`、`npm run dev:worker`。

## 资源和计费

- 域名邮箱：管理员配置接码价与默认有效期；首次提取到 4-8 位验证码后，以数据库事务扣费一次。余额不足将自动停止该租用。
- 真实邮箱：管理员导入 IMAP/API 来源和邮箱池。用户租用后首 30 分钟免费，之后每小时结算；分配时预留首小时余额，余额不足或到期自动释放。
- 邮件正文与验证码保留 30 天；业务实体软删除后 90 天清理。钱包流水、支付事件和审计日志不可修改或删除。

## 邮件接入

内部邮件接收器必须使用单独的保密凭据，并异步写入 Redis 队列：

```http
POST /api/internal/messages
X-Ingest-Secret: <INTERNAL_INGEST_SECRET>
Content-Type: application/json

{"eventId":"provider-message-id","to":"target@example.com","from":"sender@example.com","subject":"Code","text":"Your code is 483920"}
```

充值采用后台生成的兑换卡密。完整卡密仅在生成时返回一次，数据库仅保存其哈希与掩码；用户兑换时，系统在同一事务内锁定卡密、增加钱包余额、标记已兑换并写入不可变流水。商城支付和支付回调接口目前未启用。

真实邮箱 IMAP 来源在后台以 JSON 配置导入，例如 `{"host":"imap.example.com","username":"account@example.com","password":"application-password"}`。该配置使用 `ENCRYPTION_KEY` 以 AES-256-GCM 加密保存，worker 使用 IMAP 拉取未读邮件。

## 运维

- 健康检查：`GET /api/health`
- 旧 JSON 数据：先运行 `npm run db:migrate`，再运行 `npm run db:legacy-import`。
- 测试：`npm test`；前端生产构建：`npm run build`。
- 生产部署前必须使用 HTTPS 反向代理，限制 PostgreSQL/Redis 的公网访问，并定期备份 PostgreSQL volume。
