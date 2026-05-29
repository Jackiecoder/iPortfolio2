# iPortfolio2 上云实施计划（方案 A）

> 目标：保持现有功能不变，把后端 + 数据库搬到 **GCP Cloud Run + Cloud SQL Postgres**，
> 通过**手机网页（HTTPS）**访问。单用户自用，暂不做 iOS 原生 app（故**不需要 Apple
> Developer Program**）。
>
> 方案 A 选型：**云端 Postgres 作为交易数据的唯一真源**，录交易改走网页 / API。

---

## 架构总览

```
手机 Safari ──HTTPS──> Cloud Run (FastAPI 容器)
                          │
                          ├── 交易/现金/目标 ──> Cloud SQL Postgres  (真源)
                          ├── 行情历史缓存   ──> Cloud SQL Postgres  (持久缓存)
                          └── 实时行情        ──> yfinance (外部)
```

### 关键切入点（为什么改动可控）
所有 CSV（含 `cash.csv`、`cash_yield.csv`）走的是同一套 `models.Transaction` 格式，
最终都汇成内存里的 `_transactions` 列表交给 `Portfolio` 计算。因此只需把
**“从 CSV 读 Transaction”换成“从 Postgres 读 Transaction”**，`Portfolio` 与全部计算
逻辑（`portfolio.py` / `models.py`）一行都不用改。

---

## ⚠️ 工作流变化（需先接受）

`CLAUDE.md` 里“直接编本地 CSV 记交易”的流程会**作废**——真源在云上。新的记交易方式
（建议三者都保留）：

- **网页表单**：面板加“添加交易”表单，手机随手录。
- **批量 CSV 上传**：`/api/upload` 改成写 Postgres，方便一次导一批。
- **（可选）本地脚本 `scripts/add_txn.py`**：仍可对 Claude 说“今天买入 MU…”，由脚本
  通过 API 往云端插一条，保留 `CLAUDE.md` 里 `date +%Y-%m-%d` 的防错逻辑。

---

## 阶段 0 — 前置准备（手动，1–2 天）

1. 注册 GCP 账号，创建 project（如 `iportfolio2`），绑定结算账户。
2. 本地装 `gcloud` CLI，`gcloud auth login` / `gcloud config set project`。
3. 启用 API：Cloud Run、Cloud Build、Artifact Registry、Cloud SQL Admin、Secret Manager。
4. 想好一个访问 token（随机字符串），后面做鉴权用。

**产出**：能在本地 `gcloud` 操作 project。

## 阶段 1 — 数据库设计 + 数据访问层（代码，1 天）

1. 建 Cloud SQL Postgres 实例（`db-f1-micro`），库 `iportfolio`。
2. 写 `schema.sql`：
   - **`transactions`**：`id` PK、`date`、`asset`、`action`、`amount`、`quantity`、
     `ave_price`、`source`、`comment`、`broker`（取自原 CSV 父目录名）、`created_at`。
     金额/数量/价格用 `NUMERIC`（对应 `Decimal`，精度不丢）。
   - **`targets`**：`symbol` PK、`target_pct`（替代 `targets.json`）。
   - **缓存三表**：`historical_prices` / `portfolio_values` / `intraday_prices`
     （沿用 `cache_service.py` 现有结构，类型改成 `NUMERIC`/`DATE`）。
3. 新建 `app/db.py`：`psycopg_pool` 连接池，`DATABASE_URL` 从环境变量读；**本地未设时
   回退到 SQLite/CSV**，保住本地开发体验。
4. 新建 `app/repository.py`：封装 `get_all_transactions() -> list[Transaction]`、
   `insert_transaction(txn)`、`get_targets()/set_target()`。

**产出**：Postgres 库建好 + 一层干净读写 API。

## 阶段 2 — 把 load_portfolio 切到 Postgres（代码，半天）

1. 改 `app/main.py` 的 `load_portfolio()`：删掉 `DATA_DIR.glob("**/*.csv")` +
   `parse_csv_file` 那段，换成 `repository.get_all_transactions()` →
   `portfolio.add_transactions(...)`。`Portfolio`/`models.py`/计算逻辑零改动。
2. `targets` 端点从读 `targets.json` 改成走 `repository`。
3. 删掉文件 watcher `_watch_csv_files`（交易不再来自文件）；改成启动 `load_portfolio()`
   一次 + 录入后自动刷新，保留 `/api/reload`。
4. 保留 `csv_parser.py`：迁移脚本和 CSV 上传仍要用它解析。

**产出**：app 从 Postgres 读交易算组合，行为与现在一致。

## 阶段 3 — 缓存层迁 Postgres（代码，半天）

改写 `app/cache_service.py`：三张缓存表 SQL 从 SQLite 换成 Postgres
（`?`→`%s`、`INSERT OR REPLACE`→`ON CONFLICT DO UPDATE`），连接走 `app/db.py` 的池。
**对外方法签名全不变**，`price_service.py` 不用动。

**产出**：行情历史缓存持久化，重新部署/冷启动不丢。

## 阶段 4 — 写入路径：录交易（代码，半天）

1. 新增 `POST /api/transactions`：校验（复用 `models.Transaction`）→
   `repository.insert_transaction` → 刷新 portfolio。
2. 改 `POST /api/upload`：解析后写 Postgres 而非落盘。
3. 网页加“添加交易”表单（`templates/index.html` + `static/js/app.js`）。
4. （可选）`scripts/add_txn.py`：本地命令行调上面的 API，带 `date +%Y-%m-%d` 防错。

**产出**：能在云端增删交易，手机网页可录入。

## 阶段 5 — 一次性数据迁移（脚本，半天）

写 `scripts/migrate_csv_to_pg.py`：
- 遍历 `data/**/*.csv`，用现有 `parse_csv_file` 解析，父目录名作 `broker`，批量
  `INSERT` 进 `transactions`；
- `targets.json` → `targets` 表；
- 核对条数（CSV 行数 == 表行数），并与本地面板数字逐项对齐确认一致。
- 本地 `data/*.csv` 保留作历史档案（git 里留着），不再是运行时依赖。

**产出**：全部历史交易进云端 Postgres，数字对得上。

## 阶段 6 — 容器化 + 鉴权 + 部署（代码 + 手动，1 天）

1. `Dockerfile` + `.dockerignore`（不需把 `data/` 打进镜像，真源在 DB）；
   `requirements.txt` 加 `psycopg[binary]`、`psycopg_pool`。
2. token 鉴权中间件 + `/healthz` 健康检查端点。
3. secret（token、`DATABASE_URL`）进 Secret Manager。
4. `gcloud run deploy`，挂 Cloud SQL 连接、注入 secret。Cloud Run 自带 HTTPS 域名。
5. 手机访问 → 输 token → 验证 holdings/图表/录入全部正常。可“添加到主屏幕”。

**产出**：手机上能用、能录交易、数据持久在云端。

## 阶段 7（可选）— CI/CD

GitHub Actions：push 到 main 自动 `gcloud run deploy`。数据在 DB，部署不影响数据。

---

## 时间 & 成本

- **代码改动**（阶段 1–6）：约 3–4 个工作日。
- **月成本**：Cloud Run 自用近 $0 + Cloud SQL `db-f1-micro` 约 $8–10/月。

## 待定决策

- **数据访问层风格**：裸 `psycopg` + 薄 repository（轻、与现有 `sqlite3` 风格一致）
  vs SQLAlchemy ORM + Alembic（更正规、更重）。**默认倾向：裸 psycopg。**

## 建议的开发顺序

1. 先在**本地装 Postgres** 跑通整条链路（阶段 1–5），最后再上 Cloud SQL（阶段 6）——
   本地验证完再上云，省调试成本。
