# 文旅智能辅助场景 · 个性化可交互旅游规划系统

第二届浙江省大学生人工智能竞赛——文旅智能辅助场景（题目编号：JBGS-2026-06）。

面向文旅行业的「智能获客与转化引擎」：为游客生成**全面、可交互、简洁直观**的旅游规划，重构传统文旅「人工服务、固化产品、被动经营」为「智能适配、创新迭代、精准创收」。

## 核心特性

| 模块 | 实现 | 说明 |
|------|------|------|
| 意图识别 | `backend/app/skills/intent_skill.py` | 纯大模型抽取 `UserPreference` 画像，**不用正则/关键词硬编码** |
| 数据检索 | `backend/app/skills/retrieve_skill.py` | 高德 API（POI/天气/路线）；**只做打分/筛选/去重，不做路线**（路线统一归规划阶段） |
| 规划生成 | `backend/app/skills/planner_skill.py` | 大模型只负责选点（候选**按地理分片**给它，输出很短、生成快）；系统**先把景点串成一条链、再切成天**→酒店落在**切点**上→按链位置插餐与排路线，再算接驳与预算 |
| 规划体检 | `backend/app/skills/check_skill.py` | **代码判的**：按真实坐标优化路线顺序、长距段 / 异常绕行（跟本趟绕行基线比）、景点之间的折返、预算对账、必去漏排 / 重复 / 时间重叠的证伪；**模型只判三类语义问题**：点位到底是不是个景点、有没有跟用户原话冲突、有没有偏离用户填的兴趣。必要时带反馈重生成一次 |
| 路线优化 | `backend/app/skills/route.py` | 先串链再切段分天（相邻两天天然衔接、不会横跨全城）+ 每天总距离 / 折返 / 超长单段检测 + 最近邻重排与 2-opt（纯代码，秒级） |
| 行程地图 | `backend/app/services/static_map.py` | 后端代理高德**静态地图**：真实底图 + 编号标记 + 每日彩色轨迹（用 Web 服务 Key 即可，Key 不出现在浏览器） |
| 行程实拍图 | `frontend/src/components/WorkColumn.tsx` | 每个景点/餐厅/酒店卡片显示高德 POI 实拍图（已统一 https，加载失败自动隐藏不留空位） |
| 必去景点的图 | `backend/app/services/amap.py`、`backend/app/skills/photo_backfill.py` | 修掉「必去景点没有图片」：目的地下拉的 adcode 落到**区级**时不再把整趟行程缩进那个区（目的地名与父级城市一致就按城市检索）；必去景点在别的区搜不到真实记录时，改用**父级城市范围**再试一次。已存的旧规划读出来时零网络补图（用规划自带的候选池），仍缺的才按名字+坐标护栏查一次高德 |
| 必去景点选择器 | `frontend/src/components/MustVisitPicker.tsx` | 下拉选定即带 adcode 与坐标，规划时**直接用坐标**，不再按名字猜；手输仍可提交 |
| 综合分打分 | `backend/app/skills/scoring.py` | 推荐排序权重集中配置，便于调参 |
| 内容优先选餐 | `backend/app/skills/scoring.py`、`planner_skill.py` | 大模型挑"值得专门去吃"的店并优先排入（15 公里内）；本地特色店 +0.18（带 4.0 分口碑门槛）、连锁快餐 −0.30（只降权不排除，本地特色命中即豁免）；候选池除最近 5 家外，再放最多 3 家 4 公里内的本地特色店参评 |
| 协同调度 | `backend/app/orchestrator.py` | 串联五个 Skill；缺关键信息直接提示，**不用静默默认值** |
| 跳转降级 | `frontend/src/hooks/useAppJump.ts` | Scheme → 超时检测 → H5 → 复制口令 完整降级链 |
| 启动预热 | `backend/app/llm/warmup.py` | 服务启动时在后台加载模型 + 预填各 Skill 的提示词缓存，把约 2200 token 的系统提示词预填充提前付掉（本机实测首次请求 141s → 约 100s；不阻塞启动，Ollama 不可用时只记日志） |
| 实时进度 / 行程提前可见 | `backend/app/routers/api.py`（SSE） | 生成过程以 SSE 流推送：每个环节的开始与耗时实时显示，**行程初稿一到就先渲染出来**（本机实测 35s 可见，整单 89s），体检在后台继续跑完再补结论 |
| 景点去重 | `backend/app/skills/dedupe.py` | 高德对同一片景区会返回多条独立记录（实测平潭 9 个"景点"里 6 个是同一片地方）；按「距离 + 名字词干」合并，**合并了哪几个会写进体检清单**供用户核对 |
| 地域收敛 | `backend/app/skills/geo_gate.py` | 高德按**行政区**给结果（千岛湖属杭州市，离西湖 130 公里），综合分又不含距离，于是千岛湖能排到候选第 4 名。按「必去点 + 候选最密集的一带」当锚点、`clamp(2×距离P75, 15, 60)` 公里当阈值，把太远的候选挡在**自动选点**之外，并在体检里如实说明（想保留就设为必去）。前端「换一个」的备选池仍给全量 |
| 非景点场所过滤 | `backend/app/skills/spot_filter.py` | 影城（080601 电影院）、文体中心（140800 文化宫）、剧院（080603 剧场）会被兴趣分类码带进"景点"候选，实测「西航国际影城」还排进过行程。①把 080600/140800 从**兴趣检索**分类码里去掉（不再主动推荐，用户点名仍能解析）；②名字护栏（影城/影院/剧院/剧场/文体中心/体育馆/体育场/游泳馆/健身）挡掉漏网的，并写进体检清单。点名必去的不受影响，「体育公园」这类真公园不误伤 |
| 饮食禁忌 | `backend/app/skills/constraints.py` | 按店名**硬排除**触犯禁忌的餐厅（无海鲜/清真不兼容词）。只保留判得准的规则——原来的「排斥项」（爬山/排队/网红打卡）因为判据不可靠（16 个命中里 5 个误判）已整个删除：画像字段、意图抽取、体检提示词、前端表单里的那一组选项全部拿掉，不留半截 |
| 攻略与权威数据 | `backend/app/services/web_search.py`、`backend/app/skills/authority.py` | ①国家级 5A 景区名录（本地查表、零调用）给权威景点标注与轻微倾斜；②**可选**的实时攻略检索（公开搜索 API，"搜索 + 阅读"，默认关闭、只发城市名、实体必须能在高德找到）。**不爬小红书/抖音**：那些要登录、有反爬、也不合规 |
| 当日路线闭环 | `backend/app/skills/route.py` | 一天按「起点（前一晚酒店）→ 景点 → 终点（当晚酒店）」整体优化，而不是只看前半段 |

## 技术栈

- **前端**：React 18 + Vite + TypeScript + Ant Design
- **后端**：Python FastAPI + Pydantic
- **AI**：Ollama 本地推理（**必需**；未接入时系统直接明确提示，不做规则引擎降级）
- **存储**：SQLite（隐私数据本地存储、可导出）
- **部署**：Windows 一键 `.bat`（本地部署）

## 目录结构

```
HikiTravel/
├── backend/                        # FastAPI 后端
│   ├── app/
│   │   ├── models/                 # UserPreference（输入画像）/ TravelPlan（输出规划）
│   │   ├── skills/                 # 五个 Skill + 综合分 + 路线优化 + 统一异常
│   │   │   ├── intent_skill.py     # Skill1 意图识别（纯大模型，无正则）
│   │   │   ├── guard_skill.py      # 异常拦截（只建议、不擅改）
│   │   │   ├── retrieve_skill.py   # Skill2 多源检索（综合分排序）
│   │   │   ├── planner_skill.py    # Skill3 规划生成（分区 → 定酒店 → 排线）
│   │   │   ├── check_skill.py      # Skill4 规划体检与定向修复
│   │   │   ├── scoring.py          # 景点/餐厅/酒店 综合分权重
│   │   │   ├── route.py            # 地理分区、距离与折返体检、最近邻重排 + 2-opt
│   │   │   └── errors.py           # Skill 层统一异常
│   │   ├── services/               # 高德客户端 / 天气 / 静态地图参数
│   │   ├── llm/                    # Ollama 客户端
│   │   ├── routers/api.py          # 所有 HTTP 接口
│   │   ├── orchestrator.py         # Skill 协同调度 + 逐环节耗时日志
│   │   ├── store.py / db.py        # 规划持久化（SQLite）
│   │   ├── config.py               # 环境变量配置
│   │   └── main.py                 # 应用入口（静态托管 + 缓存策略）
│   ├── scripts/                    # 自检与回归脚本（见下表）
│   ├── data/                       # 运行时 SQLite（不提交）
│   ├── .env.example                # 配置模板
│   └── pyproject.toml              # uv / pip 依赖
├── frontend/                       # React 前端
│   ├── src/
│   │   ├── components/             # 偏好表单 / 规划展示 / 地图 / 跳转按钮
│   │   ├── pages/PlannerPage.tsx   # 主页面（生成、修改、历史、等待与重试）
│   │   ├── hooks/useAppJump.ts     # App 跳转降级链
│   │   ├── api/client.ts           # 接口封装（超时、取消、错误分类）
│   │   └── types/                  # 与后端对齐的 TS 类型
│   ├── index.html
│   └── vite.config.ts              # 构建时注入 __BUILD_TIME__
├── docs/量化指标.md
├── install.bat                     # Windows 一键安装部署
└── start.bat                       # Windows 一键启动（部署后日常使用）
```

### 自检脚本（`backend/scripts`）

| 脚本 | 用途 | 是否需要外部服务 |
|------|------|------------------|
| `offline_check.py` | 桩掉大模型与高德，秒级跑完整流水线（含时间轴/去重/体检回归用例） | 不需要 |
| `live_smoke.py` | 真实链路冒烟：生成 / 对话式修改 / 地图 / 异常分支 | 需要 Ollama + 高德 |
| `check_map_all.py` | 批量验证历史规划都能出地图 | 需要高德 |
| `audit_dead_code.py` | 扫未使用导入、死代码、前后端都没人用的字段 | 不需要 |

## 快速开始

### 方式一：Windows 一键部署（推荐现场演示）

双击 **`install.bat`**。脚本会自动：

1. **探测运行环境**：按 `py` 启动器 → PATH → 常见安装目录 依次查找 Python 与 Node.js（兼容「装了但没加 PATH」的情况）；
2. **缺啥补啥**：检测不到时，可一键调用 winget 自动安装，或提示手动下载地址；
3. **首次配置**：自动写入内置高德 API Key 到 `backend\.env`（无需手动申请）；
4. **安装依赖 + 构建前端**；
5. **启动服务**，浏览器访问 http://localhost:8000 即可。

之后每次只需双击 **`start.bat`** 一键启动。

### 方式二：本地开发（前后端分离）

**后端**（Python ≥ 3.10，推荐 uv，亦可用 pip）：

```bash
cd backend
cp .env.example .env      # 已内置 AMAP_API_KEY，可直接使用
# 推荐 uv（会自动建 .venv）：
uv sync
uv run uvicorn app.main:app --reload   # http://localhost:8000
```

> 没有 uv、只用 pip 的话，**务必先建虚拟环境再装依赖，不要装进全局 Python**，
> 也**不要用 `pip install -e .`**：
>
> ```bash
> python -m venv .venv
> .venv\Scripts\python -m pip install .
> .venv\Scripts\python -m uvicorn app.main:app --reload
> ```
>
> 原因：`-e`（editable 安装）会把项目的**绝对路径**写进 `site-packages\*.pth`，
> 而 `.pth` 是按系统编码（中文 Windows 上是 GBK）解码的。路径里只要有非 ASCII
> 字符（例如项目放在中文目录下），整台机器的 Python 每次启动都会
> `Fatal Python error: Failed to import the site module`——连 `python -c` 都跑不起来，
> `install.bat` / `start.bat` 也会跟着全部失效。这个坑真实踩过。

**前端**：

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173（已代理 /api 到 8000）
```

**Ollama**（必需：需求解析、规划生成与规划体检都由本地大模型完成；未安装/未启动时
接口会直接返回明确提示，不会用规则引擎凑一份"看起来也行"的规划）：

```bash
ollama pull qwen2.5:7b          # 生成模型
```

其它可调参数见 `backend/.env.example`：`OLLAMA_TIMEOUT`（本地 7B 生成较慢，默认 180 秒）、
`OLLAMA_KEEP_ALIVE`（模型常驻时长，省掉多次调用之间的重新加载）、
`OLLAMA_INTENT_MODEL`（需求抽取单独用哪个模型，留空 = 与规划同款，换小模型可提速）、
`OLLAMA_CHECK_MODEL`（体检单独用哪个模型，留空 = 与规划同款，换小模型可提速）、
`OLLAMA_PREWARM`（启动预热，默认开，设 0 关闭）、
`PLAN_MAX_REGENERATE`（规划体检后允许带反馈重新生成的次数，0 = 只体检不重生成）。

服务启动后会在后台预热（加载模型 + 预填提示词缓存，冷启动约 1 分钟，**不阻塞使用**）：
Ollama 的上下文缓存按前缀命中，预热把这部分预填充提前付掉，首次生成能省约 30~45 秒
（本机实测：未预热首次请求 141s，预热后约 98~109s）。预热进度可在 `/api/health` 的
`ollama_warm` 里看到，前端也会提示「正在预热」。

需要注意：缓存命中的是**系统提示词前缀**，每次请求独有的 payload 仍要重新预填充，
所以预热省的是"开机后的第一单"，不会让每一单都变快。

**生成过程是流式的**：前端通过 SSE（`/api/plan/stream` 等接口）接收进度，
每个环节（理解需求 → 检索 → 安排行程 → 规划体检）的开始与耗时都会实时显示；
行程排好后**立即渲染出来**，体检再在后台跑完补上结论——不用对着转圈等两分钟。
体检属于附加的质量报告，它失败时只会在体检卡片里如实写"未能完成"，不会作废行程。
非流式的 `/api/plan`、`/api/chat`、`/api/plan/revise` 仍然保留（`live_smoke.py` 在用）。

**生成耗时实测**（本机 CPU 跑 qwen2.5:7b，3 天行程）：整单约 80 秒，
其中意图解析 0~14 秒、数据检索 0.4~7 秒、规划 15~21 秒、规划体检 48~55 秒。
体检是最耗时的一步（要把整份规划读进去再写结论），但它同时也是可靠性的来源，
因此不提供"关闭体检"的开关——要提速请用 `OLLAMA_CHECK_MODEL` 换更小的模型。

## 行程地图说明

- 地图由后端代理高德**静态地图**接口渲染（`POST /api/map/static`），返回真实底图 + 编号标记
  + 每日彩色轨迹；前端拿到的只是图片，Key 始终留在服务端。
- 用现有的 **Web 服务 Key**（`AMAP_API_KEY`）即可，不需要另申请「Web端(JS API)」Key。
- 高德对静态地图有硬限制（实测：**标记 ≤ 10 组、轨迹 ≤ 4 条**，超了返回 `UNKNOWN_ERROR`），
  所以后端会自动裁剪：优先标注景点与酒店，天数多时把相邻几天合并成一条轨迹。
- 想要**可拖动缩放的交互式地图**，需要另外申请「Web端(JS API)」Key 并配置安全密钥；
  拿到后在 `frontend/.env.local` 里加 `VITE_AMAP_JS_KEY` / `VITE_AMAP_SECURITY_CODE`，
  再让 `MapView` 走 JS API 渲染（当前实现是静态图，取图失败会自动退化为示意图）。

## 数据安全与本地部署

- 数据存储于本地 SQLite（`backend/data/travelplanner.db`），隐私数据不出机。
- AI 推理走本地 Ollama，不把用户数据上传第三方。
- 动态数据（门票价/天气/POI/路线）通过高德 API 实时获取，本地不硬编码。
- 行程里的景点/餐厅/酒店实拍图同样来自高德 POI 接口，不落地存储、不做二次分发。

## 比赛注意事项

- **代码、文档、演示中不出现任何学校信息**。
- 高德 API Key 已内置，演示前无需手动配置。
- 量化指标见 [docs/量化指标.md](docs/量化指标.md)。
