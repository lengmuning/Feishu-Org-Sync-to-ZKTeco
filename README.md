# Feishu → ZKTeco 组织同步

基于 Cloudflare Worker 的单向同步服务，定时把飞书（Lark）组织架构的部门和人员信息推送到 ZKTeco E-ZKEco PRO 门禁考勤系统。

## 功能

- **定时同步**：Cron 每 1 小时整点自动执行一次
- **部门全量 upsert**：按 `deptnumber` 创建或更新部门，无需追踪增量
- **人员全量 upsert**：按飞书工号映射到 ZKTeco `pin`，创建或更新员工姓名和所属部门
- **层级保真**：BFS 遍历飞书部门树，保证父部门先于子部门写入
- **软停用**：飞书中停用或删除的部门，在 ZKTeco 侧部门名前加 `[已停用]` 前缀，**不真实删除**，避免影响部门内员工
- **只管理同步部门**：ZKTeco 里手工创建的原有部门（`deptnumber` 不以 `od` 开头）完全不受影响
- **手动触发**：`GET /sync` 立即同步部门和人员，`GET /preview` 仅预览映射结果不写入

## 数据流

```
飞书 Directory v1 API           Cloudflare Worker              ZKTeco E-ZKEco PRO
──────────────────────          ──────────────────             ───────────────────
POST /departments/filter  ───►  BFS 拉全量部门树
                                      │
                                      ▼
                                映射字段（open_id → deptnumber,
                                parent → parentnumber,
                                停用 → [已停用] 前缀）
                                      │
                                      ▼
                                POST /department/get    ◄───► 拉当前 ZKTeco 部门
                                      │
                                      ▼
                                识别孤儿（od* 前缀但飞书已无）
                                      │
                                      ▼
POST /department/update   ◄───  批量推送 (50/批)
                                      │
                                      ▼
POST /employees/filter    ───►  按启用部门拉取员工
                                      │
                                      ▼
                                映射字段（job_number → pin,
                                name → name,
                                department_id → deptnumber）
                                      │
                                      ▼
POST /employee/update     ◄───  批量推送 (100/批)
```

## 部门字段映射

| 飞书字段 | ZKTeco 字段 | 说明 |
|---|---|---|
| `department_id`（open_department_id 格式） | `deptnumber` | 去除 `-` 等非字母数字字符，最多 40 位 |
| `name.default_value` | `deptname` | 最多 40 字符 |
| `parent_department_id` | `parentnumber` | 根部门（飞书 `"0"`）→ 由 `ROOT_PARENTNUMBER` 指定 |
| `enabled_status=false` | `deptname` 加 `[已停用]` 前缀 | 软停用 |

## 人员字段映射

| 飞书字段 | ZKTeco 字段 | 说明 |
|---|---|---|
| `employee_no` / `work_info.job_number` | `pin` | 必须为 1-24 位字母或数字；缺失或格式不合法会跳过 |
| `name` / `base_info.name.name` | `name` | 最多 20 字符 |
| 查询部门 ID / `department_ids[0]` | `deptnumber` | 规则同部门 `deptnumber` |

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

以下 4 个敏感变量必须作为 Secret 注入，不要写入 `wrangler.toml`：

```bash
npx wrangler secret put FEISHU_APP_ID          # 飞书应用 App ID
npx wrangler secret put FEISHU_APP_SECRET      # 飞书应用 App Secret
npx wrangler secret put ZKTECO_ACCESS_KEY      # ZKTeco API access_key
npx wrangler secret put ZKTECO_BASE_URL        # 如 https://kqapi.example.com
```

也可在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets 中添加，**Type 选 Secret**。

### 3. 调整 `wrangler.toml`

```toml
[vars]
ROOT_PARENTNUMBER = "111"   # ZKTeco 里作为顶层根部门的 deptnumber

[triggers]
crons = ["0 * * * *"]        # 每小时整点
```

**重要**：部署前必须确保 ZKTeco 里已存在 `ROOT_PARENTNUMBER` 指定的部门，否则一级部门会写入失败（返回码 144 父部门不存在）。

### 4. 飞书应用权限

在飞书开放平台应用后台开通以下权限（全部 Directory v1 scope）：

- `contact:department.base:readonly` —— 读取部门信息（部门过滤/层级）
- `directory:employee:list` —— 调用 employees/filter 按部门列员工
- `directory:employee.base.name.name:read` —— 读取员工姓名
- `directory:employee.base.department:read` —— 读取员工所属部门
- `directory:employee.work.job_number:read` —— 读取员工工号（映射为 ZKTeco `pin`）

应用需发布并获得企业管理员审批后权限才生效。

> 注：飞书 `employees/filter` 接口要求 `base_info.departments.department_id` 必须与 `work_info.staff_status=1` 一起出现在 conditions 中，否则报 2220009 "Filter field is invalid"。代码已按此规则组合，只同步 `staff_status=1`（在职）的员工。

### 5. 部署

```bash
npx wrangler deploy
```

### 6. 验证

```bash
# 浏览器或 curl 访问
curl https://<your-worker>.workers.dev/preview   # 只预览，不写入
curl https://<your-worker>.workers.dev/sync      # 立即同步部门和人员
curl https://<your-worker>.workers.dev/sync?users=0  # 只同步部门
curl https://<your-worker>.workers.dev/sync-users     # 只同步人员

# 查看 cron 日志
npx wrangler tail
```

## 本地开发

创建 `.dev.vars` 文件（**已被 .gitignore，切勿提交**）：

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
ZKTECO_ACCESS_KEY=xxxxx
ZKTECO_BASE_URL=https://kqapi.example.com
```

启动本地 dev server：

```bash
npx wrangler dev
```

访问 `http://127.0.0.1:8787/preview` 或 `/sync` 测试。

## 路由

| 路径 | 方法 | 作用 |
|---|---|---|
| `/` | GET | 帮助信息 |
| `/preview` | GET | Dry run，返回部门和人员映射结果，不写 ZKTeco；可加 `?users=0` 跳过人员预览 |
| `/sync` | GET | 立即执行完整同步；可加 `?users=0` 只同步部门 |
| `/sync-users` | GET | 只同步人员，适合部门已同步后单独补跑 |
| `/test-person?empno=<工号>` | GET | 单人部门更新测试，返回更新前后 diff |
| `/test-dept-users?name=<部门名>` | GET | 只同步/预览指定部门的员工（加 `&dry=1` 只看不写）；也支持 `?openid=<open_department_id>` |
| （无） | scheduled | Cron `0 * * * *` 每小时整点自动触发部门和人员完整同步 |

## 行为矩阵

| 场景 | Worker 动作 |
|---|---|
| 飞书新增部门 | ZKTeco 新建部门（`od...` 编号） |
| 飞书改名 / 换父部门 | ZKTeco upsert 覆盖更新 |
| 飞书停用部门（`enabled_status=false`） | ZKTeco 部门名加 `[已停用]` 前缀 |
| 飞书删除部门 | 下次同步识别为孤儿，加 `[已停用]` 前缀（不真实删除） |
| ZKTeco 原有手工部门（非 `od...` 前缀） | 完全不动 |
| 飞书新增 / 改名员工 | ZKTeco 按 `pin` upsert 员工姓名和所属部门 |
| 飞书员工缺少工号 | 跳过，并在返回结果 `users.skippedSample` 中标记 `no_job_number` |
| 飞书员工工号含非字母数字字符 | 跳过，并标记 `invalid_pin_format` |

## 注意事项

- **严格部分更新**：每次 `employee/update/` 只发送 `{pin, name, deptnumber}` 三个字段，ZKTeco 里 `Card`、`mobile`、`email`、`position`、指纹 / 人脸 / 掌纹等生物特征数据**完整保留**
- 人员同步目前只创建或更新员工，不删除 ZKTeco 中飞书已离职或已停用的员工
- 只同步 `work_info.staff_status=1` 的员工（在职）；离职员工保持原记录不动
- 软停用的部门里原有员工保持在原位，避免误删人员数据
- 飞书限流：每小时一次同步对中小企业（<500 部门）无压力；如果全量 subrequest 接近 Worker 免费版 50 次上限，建议升级 Workers Paid 或再降低频率
- Worker subrequest 限制：免费版 50 次/调用，付费版 1000 次。本项目部署架构下约 20–25 次 subrequest，免费版可用；部门数量暴增时需留意
- Worker CPU 时间限制：免费版 10ms，付费版 30s。本项目单次同步约 15–25 秒，**推荐 Workers Paid（$5/月）**
- 本项目是 **单向同步**（飞书 → ZKTeco），反向变更不会回写飞书

## 安全

- 所有密钥（app_secret、access_key、base_url）均通过 Cloudflare Secrets 管理，不进入代码仓库
- `.dev.vars`、`node_modules/`、`.wrangler/` 均已在 `.gitignore` 中
- 建议仓库设为 Private，即便如此也不要把真实密钥写进代码或 `wrangler.toml`

## License

MIT
