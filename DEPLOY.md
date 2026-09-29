# 部署说明（v8.0）

面向"拿到一个压缩包，要在一台机器上跑起来"的场景。
README 讲项目是什么，这里只讲**怎么装、装完怎么验、坏了怎么修**。

---

## 1. 最短路径

```bash
node deploy.mjs     # 装依赖、建目录、生成配置
node start.mjs      # 起服务 + 保活
```

打开 <http://127.0.0.1:8800/hub.html>

**Windows**：双击 `启动全部.bat`（它先跑部署再起服务）。
**Linux / macOS**：`chmod +x start-all.sh && ./start-all.sh`

---

## 2. 部署脚本做了哪六步

```
[1/6] 环境检查      Node / Python / uv / Ollama 逐个探测
[2/6] 运行目录      建 uploads / generated / copybooks / .cache
[3/6] Python 依赖   确认 Pillow 能 import（不是确认 pip 存在）
[4/6] 后端依赖      uv sync 或 venv+pip
[5/6] 前端          frontend/dist 在就不动；不在才 npm build
[6/6] 生成配置      brain.config.json + hikitravel/backend/.env
```

### 每一步都可以单独重跑

部署失败是常态（网络、权限、端口），所以每步先探测"是不是已经就绪"：

```bash
node deploy.mjs            正常跑（已就绪的跳过）
node deploy.mjs --check    只体检，不改任何东西
node deploy.mjs --force    忽略"已就绪"，全部重做
```

### 判断标准是"能力"，不是"包管理器"

这一条是踩过坑才写下的。原来的检查是：

```js
// 错的
if (!hasPip(python)) return bad("环境不合格");
```

但有一台机器 Python 好好的、Pillow 也装着、渲染完全正常，**就是没有 pip**
（依赖是别的方式装的）。脚本却报"环境不合格" —— 凭空造出一个故障。

现在改成：

```js
// 对的：先看能不能 import，再看有没有工具去修
const m = run(python, ["-c", "import PIL; print(PIL.__version__)"]);
if (m.ok) return ok("已装，不需要 pip");
```

**依赖装法有很多种，不该假设只有一种。**

同理，`qrcode` 是**可选**依赖（没有它只是不画二维码），
所以探测只把 `Pillow` 当必需 —— 把可选项算进"必需"，也会造出不存在的故障。

---

## 3. 端口与进程

| 端口 | 服务 | 必需 | 说明 |
|---|---|---|---|
| **8800** | 海报站点 | 是 | Node，零 npm 依赖 |
| **8001** | 旅游规划后端 | 否 | FastAPI；不起的话门户里那张卡会提示"服务没在运行" |
| **11434** | Ollama | 否 | 本机模型；不起的话文案走内置规则 |

### 三个服务会自己死

实测日志末尾是 `^C^C^C^C^C` —— 是被 **Ctrl+C 信号**打死的，**不是崩溃、不是 OOM**。
可能是别的程序收控制台时连带。具体来源没查明。

所以 `start.mjs` 把**启动和保活做成一件事**：

```
每 20 秒检查一次端口 → 不在就拉起来 → 再等 20 秒
```

拉起用 `detached + unref` —— 它必须活得比父进程久，
否则父进程一收工它跟着没，等于没守。

**单独启动某个服务**（调试时用）：

```bash
cd posterforge && node server.mjs --port 8800
cd hikitravel/backend && uv run python -m uvicorn app.main:app --port 8001
```

---

## 4. Ollama 与模型

### 项目会自己拉起 Ollama

不需要你手动 `ollama serve`。`posterforge/brain.mjs` 里有 `ensureOllama()`：
进来先探，不在就自己起（detached），等端口就绪再发请求。

**实测**：杀掉 Ollama → 发一次生成请求 → 它自己把模型拉起来并正常出图
（125.9 秒，含模型加载）。

### 装模型

```bash
ollama pull qwen2.5:7b      # 约 4.7GB，写文案
ollama pull qwen2.5vl:3b    # 约 3.2GB，读照片
```

### 显存/内存不够

编辑 `posterforge/brain.config.json`：

| 配置 | 效果 |
|---|---|
| `"vision": null` | 不读图，只写文案 |
| `"copy": null` | 不写文案，走内置确定性规则 |
| 两个都 null | 完全不用模型，出图链路照常 |
| `"enabled": false` | 整个模型层关掉 |

**模型不是必需的** —— 这是设计前提。没有模型时海报照样出，
只是文案由内置规则生成而不是模型写的。

---

## 5. 配置项

### `posterforge/brain.config.json`

真实配置**不进版本库**（每台机器的路径和模型都不同）。
仓库里是 `brain.config.example.json`，部署脚本复制并填好探测到的 Python 路径。

| 字段 | 说明 |
|---|---|
| `python` | 渲染用哪个 Python。**部署脚本会自动改写** —— 从别人机器拷来的配置，这行多半是错的 |
| `endpoint` | Ollama 地址，装在别的机器上就改成那台 IP |
| `vision` / `copy` | 模型名，`ollama list` 看本机有哪些 |
| `keepAlive` | 模型在显存里留多久（`30m`）|

### `hikitravel/backend/.env`

```
STATIC_DIR=<frontend/dist 的绝对路径>
NO_PROXY=127.0.0.1,localhost
```

- **`STATIC_DIR` 不设的话，后端起来也不服务前端页面**（打开是 404）
- **`NO_PROXY` 很重要**：本机若有系统代理，Python 的 httpx/urllib 会走代理
  去连 127.0.0.1，表现是 502 或 SSL EOF

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PF_PORT` | 8787 | 海报站点端口（`start.mjs` 用的是 8800） |
| `PF_WENLV_ORIGIN` | `http://127.0.0.1:8001` | 门户反代指向哪 |
| `WATCH_INTERVAL` | 20000 | 保活检查间隔（毫秒） |
| `OLLAMA_BIN` | 自动探测 | ollama 可执行文件路径 |

---

## 6. 排错

### 打不开 / 卡

```bash
node deploy.mjs --check     # 环境
node start.mjs --once       # 只拉起服务，不守
```

日志：`posterforge/.work/logs/`（`start.log` / `site.log` / `site.err.log`）

### 点了按钮没反应

先 **Ctrl+F5 强刷**。这个项目栽过**三次**同一个坑：

| 改了什么 | 为什么用户看不到 |
|---|---|
| 助手组件加设置齿轮 | `ai-ball.js` 设了 `max-age=3600` |
| 重渲 41 张缩略图 | 缩略图 URL 没变，还带一小时缓存 |
| 往反代 HTML 里注入返回按钮 | 反代**透传了上游的缓存头** |

**规矩（写进代码注释了）：会被迭代覆盖的资源，一律不许长缓存。**
HTML 里的助手组件引用还带版本号（取自文件修改时间），改了就自动换 URL。

### 出图很慢

| 操作 | 正常耗时 |
|---|---|
| 套模板后生成海报 | 约 6 秒 |
| 首次点 AI 背景 | 约 20 秒（要加载模型进显存） |
| 首次让模型写文案 | 约 3~10 秒（模型加载） |
| 之后每次 | 1~3 秒 |

首次慢是模型加载，不是卡。8GB 显存下若要同时跑 Ollama 和 SDXL-Turbo，
先把 Ollama 卸了（`keepAlive` 设短，或 `ollama stop`）。

### 页面显示"服务没在运行"

那张卡是旅游规划。它没起：

```bash
cd hikitravel/backend && uv run python -m uvicorn app.main:app --port 8001
```

海报不受影响。

### Python 没 pip

装不了依赖时的三条路（部署脚本会打出来）：

```bash
python -m ensurepip --upgrade                              # 装 pip
uv pip install --python <python路径> -r renderer/requirements.txt   # 换 uv
pip install Pillow qrcode                                  # 手动
```

---

## 7. 素材来源与版权

| 素材 | 来源 | 版权 |
|---|---|---|
| **Live2D 模型** (hiyori) | 从同机另一个项目搬入 | 归原作者；本项目仅作演示 |
| **pixi / Cubism core** | Live2D 官方 SDK 运行时 | 见 Live2D 官网许可条款 |
| **联网灵感图** | Bing 每日壁纸 | **只作配色与版式参考，界面已注明"图片本身不进成品"** |
| **模板配图**（缩略图用） | 项目内 `.work/tplbg/` | 演示用途 |

**要商用的素材请接 Pexels / Unsplash**（需各自 API key，见 `posterforge/feed.config.json`）。
旅游规划部分的地图与景点数据版权见 `hikitravel/README.md`。

---

## 8. 目录里哪些不该进版本库

`.gitignore` 已排掉：

- `public/uploads` `public/generated` `public/copybooks` —— **用户用出来的东西**，不是项目的一部分
- `brain.config.json` `assistant.json` `history.json` `templates-user.json` —— 本机个人数据
- `.cache/` `.work/` `node_modules/` `.venv/` `__pycache__/`
- 模型权重（几 GB，按需下载）

**打包后 12.4 MB / 312 文件**（含已构建的 `frontend/dist` 和 Live2D 形象资源）。
