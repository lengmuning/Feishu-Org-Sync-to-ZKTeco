# Feishu → ZKTeco 组织同步

基于 Cloudflare Worker 的单向同步服务，把飞书（Lark）组织架构的部门和人员变动**实时**推送到 ZKTeco E-ZKEco PRO 门禁考勤系统。

## 功能

- **事件驱动实时同步**：订阅飞书部门、通讯录员工或 CoreHR 员工事件，部门或员工变动后秒级写入 ZKTeco，不再依赖每小时轮询
- **每日兜底全量同步**：每天北京时间凌晨 3:00 自动跑一次完整同步，作为 webhook 漏推或外部修改的安全网
- **部门 upsert**：按 `deptnumber` 创建或更新部门，支持改名、换父部门
- **人员 upsert**：按飞书工号映射到 ZKTeco `pin`，创建或更新员工姓名和所属部门
- **层级保真**：全量同步时 BFS 遍历飞书部门树，保证父部门先于子部门写入
- **软停用**：飞书中停用或删除的部门，在 ZKTeco 侧部门名前加 `[已停用]` 前缀，**不真实删除**，避免影响部门内员工
- **只管理同步部门**：ZKTeco 里手工创建的原有部门（`deptnumber` 不以 `od` 开头）完全不受影响
- **Webhook 安全**：飞书 Verification Token 校验，避免伪造请求
- **手动触发**：`GET /sync` 立即同步，`GET /preview` 仅预览映射结果不写入

## 数据流

```
飞书事件订阅                   Cloudflare Worker              ZKTeco E-ZKEco PRO
──────────────                 ──────────────────             ───────────────────
contact.department.*_v3  ───►  POST /feishu/webhook
contact.user.*_v3              · token 校验
corehr.job_data.*_v1
corehr.person.updated_v1
corehr.employment.resigned_v1
                               · 同步处理，成功后返回 200
                               · 失败返回 500，让飞书重试
                                       │
                                       ▼
                               增量映射单条记录            POST /department/update
                               （部门 / 员工 upsert）  ───►   或 /employee/update
                               （删除 → [已停用] 前缀）

每日 03:00 (Asia/Shanghai) ──► scheduled() 兜底全量同步
                               · BFS 拉飞书部门树
                               · 拉飞书在职员工
                               · 识别孤儿（od* 但飞书已无）→ [已停用]
                               · 批量 upsert
```

## 部门字段映射

| 飞书字段 | ZKTeco 字段 | 说明 |
|---|---|---|
| `department_id`（open_department_id 格式） | `deptnumber` | 去除 `-` 等非字母数字字符，最多 40 位 |
| `name.default_value` / 事件中的 `name` | `deptname` | 最多 40 字符 |
| `parent_department_id` | `parentnumber` | 根部门（飞书 `"0"`）→ 由 `ROOT_PARENTNUMBER` 指定 |
| 事件 `contact.department.deleted_v3` 或 `enabled_status=false` | `deptname` 加 `[已停用]` 前缀 | 软停用 |

## 人员字段映射

| 飞书字段 | ZKTeco 字段 | 说明 |
|---|---|---|
| `employee_no` / `work_info.job_number` | `pin` | 必须为 1-24 位字母或数字；缺失或格式不合法会跳过 |
| `name` / `base_info.name.name` | `name` | 最多 20 字符 |
| `department_ids[0]` / `base_info.departments[0]` | `deptnumber` | 规则同部门 `deptnumber` |

CoreHR 事件只带 `employment_id` / `person_id`，Worker 按以下顺序解析（**先快后慢**）：

1. `employment_id` → CoreHR `employees/search` → 拿 `employee_number` → Directory 按工号查单人详情，补齐姓名和部门后同步（优先轻量路径）
2. 上一步失败 → CoreHR ID convert → `open_id` → Contact `users/:id` GET；如果 Contact 不可用，再 fallback 到 Directory 员工索引
3. 仍失败 → 直接使用 CoreHR 员工对象兜底（请求字段包含 `job_data` / `job_datas`，尽量保留部门信息；如果飞书字段校验失败，会自动降级为基础字段重试）
4. 事件只带 `person_id` → CoreHR `employees/batch_get` 后同样优先用工号查 Directory，失败再走 ID convert / Directory 索引兜底

`tenant_access_token` 做了模块级缓存（TTL 100 分钟，飞书 token 实际 2 小时过期）。Directory 员工数据不做结果缓存；同一个 Worker isolate 内多个 CoreHR 事件并发触发时，会等待同一个 in-flight Directory 拉取 Promise，避免重复消耗 subrequest。

## 部署

### 1. 准备

确保已安装 Node.js (≥18) 和拥有 Cloudflare 账号。

```bash
git clone <repo>
cd <repo>
npm install
npx wrangler login
```

### 2. 配置 Secrets

以下 5 个敏感变量必须作为 Secret 注入，不要写入 `wrangler.toml`：

```bash
npx wrangler secret put FEISHU_APP_ID                # 飞书应用 App ID
npx wrangler secret put FEISHU_APP_SECRET            # 飞书应用 App Secret
npx wrangler secret put FEISHU_VERIFICATION_TOKEN    # 飞书事件订阅 Verification Token
npx wrangler secret put ZKTECO_ACCESS_KEY            # ZKTeco API access_key
npx wrangler secret put ZKTECO_BASE_URL              # 如 https://kqapi.example.com
```

也可在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets 中添加，**Type 选 Secret**。

### 3. 调整 `wrangler.toml`

```toml
[vars]
ROOT_PARENTNUMBER = "111"   # ZKTeco 里作为顶层根部门的 deptnumber

[triggers]
crons = ["0 19 * * *"]      # UTC 19:00 = 北京时间次日 03:00 兜底全量同步
```

**重要**：部署前必须确保 ZKTeco 里已存在 `ROOT_PARENTNUMBER` 指定的部门，否则一级部门会写入失败（返回码 144 父部门不存在）。

> Cloudflare Workers cron 只支持 UTC，要在东八区 03:00 执行需写 `0 19 * * *`（前一天 UTC 19:00）。

### 4. 飞书应用权限

在飞书开放平台应用后台开通以下权限：

**REST API（用于全量同步）— Directory v1 scope**
- `contact:department.base:readonly` —— 读取部门信息
- `directory:employee:list` —— 调用 employees/filter 按部门列员工
- `directory:employee.base.name.name:read` —— 读取员工姓名
- `directory:employee.base.department:read` —— 读取员工所属部门
- `directory:employee.work.job_number:read` —— 读取员工工号

**事件订阅（用于实时同步）— Contact v3 scope（任一即可）**
- `contact:contact.base:readonly` —— 获取通讯录基本信息
- 或 `contact:contact:readonly_as_app`

**CoreHR 事件兜底（只有 CoreHR 事件、没有 contact.user 事件时需要）**
- `corehr:employee:readonly` —— 按 `employment_id` 查询员工信息

> Contact GET (`contact/v3/users/:id`) 走通讯录读取权限。当前代码已对 Contact 无权限场景做 fallback，会继续通过 Directory 员工索引反查。

应用需发布并获得企业管理员审批后权限才生效。

> 注：飞书 `employees/filter` 接口要求 `base_info.departments.department_id` 必须与 `work_info.staff_status=1` 一起出现在 conditions 中，否则报 2220009 "Filter field is invalid"。代码已按此规则组合，只同步 `staff_status=1`（在职）的员工。

### 5. 部署 Worker

```bash
npx wrangler deploy
```

### 6. 配置飞书事件订阅

部署完拿到 Worker URL 后，到飞书开发者后台 → 「事件与回调」 → 「事件订阅」：

1. **请求地址 URL** 填：`https://<your-worker>.workers.dev/feishu/webhook`
   - 飞书会立刻 POST 一个 `url_verification` challenge，Worker 自动响应
   - 显示「保存成功」即握手通过
2. 点击「**添加事件**」，按 event_type 名称搜索并订阅以下事件：

| 中文名 | event_type |
|---|---|
| 部门新建 | `contact.department.created_v3` |
| 部门信息变化 | `contact.department.updated_v3` |
| 部门被删除 | `contact.department.deleted_v3` |
| 员工入职 | `contact.user.created_v3` |
| 员工信息变化 | `contact.user.updated_v3` |
| 员工离职 | `contact.user.deleted_v3` |
| CoreHR 新员工入职 | `corehr.job_data.employed_v1` |
| CoreHR 员工异动 | `corehr.job_data.changed_v1` |
| CoreHR 个人信息变更 | `corehr.person.updated_v1` |
| CoreHR 员工完成离职 | `corehr.employment.resigned_v1` |

3. 在「凭证与基础信息」复制 **Verification Token** 配到 Worker 的 `FEISHU_VERIFICATION_TOKEN` Secret

### 7. 验证

浏览器或 curl 访问：

```bash
curl https://<your-worker>.workers.dev/                       # 帮助信息
curl https://<your-worker>.workers.dev/preview?users=0        # 部门预览（不写入）
curl https://<your-worker>.workers.dev/preview                # 部门 + 员工预览
curl https://<your-worker>.workers.dev/sync                   # 立即全量同步
```

实时事件验证：
- 在飞书改一个测试部门名称
- Cloudflare Dashboard → Worker → 实时日志应出现 `webhook ok <event_type> <event_id> ...`
- 飞书开发者后台 → 「事件与回调」 → 「推送记录」应看到 200 响应
- 如果 ZKTeco 写入失败，Worker 会返回 500，飞书侧推送记录会显示失败并按飞书策略重试

## 本地开发

创建 `.dev.vars` 文件（**已被 .gitignore，切勿提交**）：

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
FEISHU_VERIFICATION_TOKEN=xxxxx
ZKTECO_ACCESS_KEY=xxxxx
ZKTECO_BASE_URL=https://kqapi.example.com
```

启动本地 dev server：

```bash
npx wrangler dev
```

访问 `http://127.0.0.1:8787/preview` 测试。本地无法接收公网 webhook，要测 webhook 可用 `wrangler dev --remote` 或部署后用 `wrangler tail` 看实时日志。

## 路由

| 路径 | 方法 | 作用 |
|---|---|---|
| `/` | GET | 帮助信息 |
| `/feishu/webhook` | POST | **飞书事件订阅入口**，处理 url_verification + 部门 / 员工增量事件 |
| `/preview` | GET | Dry run，返回部门和人员映射结果，不写 ZKTeco；可加 `?users=0` 跳过人员预览 |
| `/sync` | GET | 立即执行完整同步；可加 `?users=0` 只同步部门 |
| `/sync-users` | GET | 只同步人员，适合部门已同步后单独补跑 |
| `/test-person?empno=<工号>` | GET | 单人部门更新测试，返回更新前后 diff |
| `/test-dept-users?name=<部门名>` | GET | 只同步/预览指定部门的员工（加 `&dry=1` 只看不写）；也支持 `?openid=<open_department_id>` |
| （无） | scheduled | Cron `0 19 * * *`（UTC）= 北京时间次日 03:00，自动跑兜底全量同步 |

## 行为矩阵

| 场景 | 触发方式 | Worker 动作 |
|---|---|---|
| 飞书新增部门 | webhook `contact.department.created_v3` | ZKTeco 新建部门（`od...` 编号） |
| 飞书改名 / 换父部门 | webhook `contact.department.updated_v3` | ZKTeco upsert 覆盖更新 |
| 飞书停用部门（`enabled_status=false`） | 兜底全量 | ZKTeco 部门名加 `[已停用]` 前缀 |
| 飞书删除部门 | webhook `contact.department.deleted_v3` | ZKTeco 部门名加 `[已停用]` 前缀（不真实删除） |
| ZKTeco 原有手工部门（非 `od...` 前缀） | 全部场景 | 完全不动 |
| 飞书新增员工 | webhook `contact.user.created_v3` | ZKTeco 按 `pin` 创建员工 |
| 飞书改名 / 换部门 | webhook `contact.user.updated_v3` | ZKTeco 按 `pin` upsert |
| 飞书员工离职 | webhook `contact.user.deleted_v3` | 仅记录日志（与全量同步策略一致，不删 ZKTeco 数据） |
| CoreHR 新员工入职 | webhook `corehr.job_data.employed_v1` | 反查员工后按 `pin` upsert |
| CoreHR 部门 / 上级异动 | webhook `corehr.job_data.changed_v1` | 反查员工后按 `pin` upsert |
| CoreHR 个人信息变更 | webhook `corehr.person.updated_v1` | 反查员工后按 `pin` upsert |
| CoreHR 员工完成离职 | webhook `corehr.employment.resigned_v1` | 仅记录日志，不删 ZKTeco 数据 |
| 飞书员工缺少工号 | 全部场景 | 跳过，全量同步在 `users.skippedSample` 中标记 `no_job_number` |
| 飞书员工工号含非字母数字字符 | 全部场景 | 跳过，标记 `invalid_pin_format` |
| Webhook 漏推或外部直接改 ZKTeco | 兜底全量 | 每天 03:00 全量比对修正 |

## 注意事项

- **严格部分更新**：每次 `employee/update/` 只发送 `{pin, name, deptnumber}` 三个字段，ZKTeco 里 `Card`、`mobile`、`email`、`position`、指纹 / 人脸 / 掌纹等生物特征数据**完整保留**
- 人员同步目前只创建或更新员工，不删除 ZKTeco 中飞书已离职或已停用的员工
- 只同步 `work_info.staff_status=1` 的员工（在职）；离职员工保持原记录不动
- 软停用的部门里原有员工保持在原位，避免误删人员数据
- **Webhook 同步 ACK**：Worker 会先完成 ZKTeco 写入，成功后返回 200；如果反查或写入失败，则返回 500，让飞书按事件订阅机制重试
- **幂等性**：飞书可能重试同一事件，ZKTeco 的 update 接口按 `pin`/`deptnumber` upsert，天然幂等
- Worker subrequest 限制：免费版 50 次/调用，付费版 1000 次
  - **contact.* webhook 单事件**：1-2 次（直接读事件 payload + push ZKTeco）
  - **corehr.* webhook 单事件**：优先轻量路径（token + ID convert + Contact GET + push）；如果 Contact GET 落空，fallback 到 Directory 批量员工索引。并发事件共享同一个 in-flight Directory 拉取；事件路径禁用逐部门 fallback，避免超过免费版 subrequest 限制
  - **兜底全量同步**：约 20–25 次
- Worker CPU 时间限制：免费版 10ms，付费版 30s
  - **webhook 单事件**：通常 <1s（命中 Contact 直接路径）；fallback 到 Directory 批量索引时约 5-15s，取决于飞书和 ZKTeco API 响应
  - **兜底全量同步**：约 15-25s
  - 当前事件路径按免费版 subrequest 预算设计；如果组织规模继续扩大或 CoreHR 事件短时间大量并发，再考虑 Workers Paid
- 本项目是 **单向同步**（飞书 → ZKTeco），反向变更不会回写飞书

## 监控与排查

- **飞书侧推送记录**：开发者后台 → 「事件与回调」 → 「推送记录」 查看每个事件的 HTTP 响应
- **Cloudflare 实时日志**：Workers & Pages → 你的 Worker → 「日志」 → 「实时日志」
- **Cron 历史**：Workers & Pages → 你的 Worker → 「Cron Triggers」 查看上次触发时间和耗时
- **快速健康检查**：`curl https://<your-worker>.workers.dev/preview?users=0`，看 `activeCount > 0` 即视为飞书 / 映射逻辑正常

## 安全

- 所有密钥均通过 Cloudflare Secrets 管理，不进入代码仓库
- `.dev.vars`、`node_modules/`、`.wrangler/`、`.claude/` 建议加入 `.gitignore`
- Webhook 通过 Verification Token 校验，拒绝无 token 或 token 错误的请求
- 即便仓库设为 Private，也不要把真实密钥写进代码或 `wrangler.toml`

## License

MIT
