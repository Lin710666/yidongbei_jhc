# PosterForge 本地部署说明

宣传海报与打卡模板生成站点。视觉与排版参照 [Hyper3D Rodin](https://hyper3d.ai/)，
业务落到文旅场景：**文旅局、酒店、饭馆、游客**。

---

## 一、这个站点是什么

一个**能真正出图的**本地 Web 应用。不是页面原型：

```
浏览器表单/模板选择
      ↓  POST /api/generate
本地 Node 服务（零依赖）
      ↓  子进程调用
validate.py  ← 先校验：结构 / 颜色令牌 / 广告法 / 事实来源
      ↓  通过才渲染
render.py    ← PIL 确定性合成
      ↓
真实 PNG 回传并显示
```

**实测端到端耗时约 0.8 秒**（冷启动 Python + 校验 + 渲染 1080×1440 + 落盘）。
比任何图像模型快几个数量级 —— 因为这是 CPU 合成，不是采样。

---

## 二、依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | 18+ | 服务端。**无 npm 依赖**，不用 `npm install` |
| Python | 3.10+ | 渲染器 |
| Pillow | 任意近期版本 | `python -m pip install pillow` |
| 中文字体 | Windows 自带即可 | 微软雅黑 / 黑体 / 等线 / 华文中宋 |
| 浏览器 | 任意现代浏览器 | 前端用原生 JS，无构建步骤 |

**可选**：`qrcode`（二维码图元）、ComfyUI（AI 背景图）。

---

## 三、目录结构

```
deepseck/
├─ poster-forge/                ← 渲染引擎（独立可用，不依赖站点）
│   ├─ render.py                图层栈渲染器
│   ├─ bg.py                    背景与调色板（单一职责）
│   ├─ validate.py              合规校验器
│   ├─ schemas/                 PosterSpec 契约
│   ├─ layouts/                 版式与主题
│   ├─ specs/                   示例内容
│   └─ out/                     成品
│
└─ site/                        ← 本站点
    ├─ server.mjs               零依赖 Node 服务（含上传/手册/ComfyUI 路由）
    ├─ comfy.mjs                ComfyUI 客户端（官方 Qwen-Image-2.1 拓扑）
    ├─ copybook.py              多页 PDF 文案手册渲染器
    ├─ build_assets.py          生成缩略图与案例图
    ├─ shots.mjs                CDP 截图自检（验证页面真的渲染出来了）
    ├─ drive-test.mjs           CDP 交互测试（真的点按钮、真的走链路）
    ├─ comfy-test.mjs           ComfyUI 分级测试（探活/模型/真实生成）
    ├─ specs/                   手册与示例 spec
    ├─ 启动站点.bat             一键启动（含环境自检）
    ├─ public/                  静态前端
    │   ├─ index.html
    │   ├─ style.css
    │   ├─ app.js
    │   ├─ thumbs/              14 张模板缩略图 + 案例图
    │   └─ generated/           运行时产出
    └─ skills/                  ★ Skill 工作流文档
        ├─ README.md            总览与四步链路
        ├─ manifest.json        技能索引
        ├─ poster-spec/         契约层
        ├─ compliance-check/    校验把关
        ├─ render-pipeline/     合成层
        ├─ bureau-poster/       文旅局
        ├─ hotel-promo/         酒店
        ├─ restaurant-promo/    饭馆
        ├─ tourist-checkin/     游客打卡
        └─ image-layer/         图像层（AI 出图接入点）
```

---

## 四、启动

### 方式一：一键启动（推荐）

双击 `site\启动站点.bat`。它会先自检环境（Node / Python / Pillow / 渲染器），
任何一项缺失都会明确告诉你补什么，然后启动服务。

### 方式二：命令行

```powershell
cd E:\deepseck\site
node server.mjs                 # 默认 8787
node server.mjs --port 9000     # 换端口
```

打开 <http://127.0.0.1:8787>。

### 环境自检

浏览器右下角会出现自检徽标，或直接访问：

```
http://127.0.0.1:8787/api/health
```

返回 Python 版本、渲染器是否找到、Node 版本。**任一项不对页面会显示"环境待检查"。**

---

## 五、API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 环境自检（含 ComfyUI 是否在跑） |
| GET | `/api/templates` | 模板列表（含分类） |
| GET | `/api/cases` | 案例 + 趋势 feed |
| GET | `/api/capabilities` | 功能菜单 |
| POST | `/api/generate` | **真实生成海报/打卡卡**，body 传 `{"spec": {...}}` |
| POST | `/api/upload` | **照片上传**（base64 + 魔数校验，单张 ≤12MB，最多 6 张） |
| POST | `/api/copybook` | **多页 PDF 手册**（先校验后渲染，失败返回 422 + 逐条报告） |
| GET | `/api/storage` | 各产出目录占用与保留规则 |
| POST | `/api/cleanup` | 手工触发目录清理（双条件保留策略） |
| GET | `/api/comfy/status` | ComfyUI 探活 + 模型文件可见性 |
| POST | `/api/comfy/background` | **AI 背景生成**（Qwen-Image-2.1） |
| POST | `/api/comfy/interrupt` | 中断当前生成 |

生成示例：

```powershell
$body = @{ spec = @{
  canvas = @{ width = 1080; height = 1440 }
  meta   = @{ id='api-demo'; audience='hotel'; client='示例酒店'; facts_source='API 调用' }
  theme  = @{ palette = @{ bgFrom='#0b2a30'; bgTo='#1d5f66'; ink='#ffffff'; gold='#e8c37a' } }
  background = @{ type='gradient'; from='bgFrom'; to='bgTo'; angle=130 }
  layers = @(
    @{ type='text'; name='title'; text='API 演示'; x=0.074; y=0.25;
       font='heavy'; size=110; color='ink' }
  )
} } | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/generate' -Method Post `
  -ContentType 'application/json' -Body $body
```

返回 `{ ok: true, url: "/generated/xxx.png", bytes: 185018, validation: "...", renderLog: "..." }`。

**失败时返回 `{ ok: false, stage: "validate"|"render", message: "..." }`**，
`message` 是校验器或渲染器的原文，便于直接定位问题。

---

## 六、重建素材

缩略图和案例图是脚本生成的，改主题后重跑即可：

```powershell
& 'E:\devenv\Scripts\python.exe' site\build_assets.py
```

生成 8 张竖版模板缩略图 + 6 张横版案例图到 `site\public\thumbs\`。

---

## 七、页面自检（改动前端后跑）

```powershell
cd E:\deepseck\site
node shots.mjs
```

用 CDP 驱动 Edge 无头浏览器，读回页面真实状态并把各区块截图存到 `.work\`：

```
页面自检: {"title":"...","tplCards":8,"caseCards":6,"capBtns":4,
           "feedItems":4,"skillCards":4,"bodyH":3443,"imgsTotal":15}
```

这是**唯一能证明"页面真的渲染出来了"** 的手段 —— 只看 HTTP 200 无法说明
异步数据有没有到达、图片有没有加载。

### 交互测试（改前端逻辑后跑）

```powershell
cd E:\deepseck\site
node drive-test.mjs                    # 上传 + 打卡卡 + 手册
node drive-test.mjs --with-ai-bg       # 额外跑真实 AI 背景生成（慢）
```

它通过 CDP **真的去点按钮**：构造 File 对象塞进 input 触发上传、
点生成按钮、读回真实结果。证明的是"交互链路可用"，
而不只是"页面渲染出来了"。

### ComfyUI 分级测试

```powershell
node comfy-test.mjs --skip-gen         # 只测探活 + 模型可见性
node comfy-test.mjs --size 512         # 真实生成（首次加载权重较慢）
```

按"探活 → 模型可见性 → 真实生成"分层，便于定位问题出在哪一层。

---

## 八、设计语言（对照参考站）

| 元素 | 参考站（Rodin） | 本站 |
|---|---|---|
| 底色 | 极暗暖棕渐变 | 同 |
| 辉光 | 暖橙 + 紫，大半径模糊缓慢漂移 | 同 |
| 主标题 | 衬线大字 `Rodin` | `PosterForge`（Playfair Display + 宋体回退） |
| 标题副行 | `Gen-2.5 READY` | `Gen-2.5 Agent-Ready` |
| 功能标签 | 胶囊，选中态粉紫渐变 | 海报 / 打卡 |
| 中央卡 | 半透明玻璃 + 暖光晕 | 上传区 + 风格片 + 生成按钮 |
| 主按钮 | 粉紫渐变 | 同 |
| 社区网格 | 卡片 + ♥/👍 计数 + 作者 | 模板网格 + ♥/💬 计数 |
| 右侧栏 | OmniCraft / Texture Generator | 工具箱 / Story / 分享推广 |
| 案例区 | YouTube 视频墙 | 爆火案例（播放键 + 平台 + 时长） |

**文案替换**（按你的要求）：
- `Rodin` → `PosterForge`
- 英文副标题 → `Poster · Check-in · Copybook｜宣传海报与打卡模板生成`
- 功能简介 → "给文旅局、酒店、饭馆做宣传物料，给游客做打卡模板"
- 3D 模型网格 → 热门模板网格
- 视频墙 → 爆火宣传海报/打卡案例

---

## 九、已知限制

### 已实现（本轮补齐）

| 能力 | 实现 | 实测结果 |
|---|---|---|
| 照片上传 | `POST /api/upload` | 60 KB 照片落盘；伪造文件被字节校验拒绝 |
| 照片 → 打卡卡 | 上传路径写进 spec | 走 UI 实点生成，结果标注"使用上传照片" |
| 多页 PDF 手册 | `copybook.py` | 6 页 A4 / 2.18 MB / 约 3 秒 |
| AI 背景生成 | `comfy.mjs` + Qwen-Image-2.1 | 512×512 生成 72 秒；8 GB 显存跑通 |
| 手册校验 | `validate-copybook.py` | 埋错 spec 拦下 13 error；先校验后渲染 |

### 仍未实现

| 项 | 说明 |
|---|---|
| ~~手册专用校验器~~ | ✅ **已完成** —— `validate-copybook.py`，服务端先校验后渲染，报告逐条展示在前端 |
| 手册图文混排 / 自动分页 | 一个版块固定一页，文字超出会溢出而不换页 |
| 中文竖排 | 未实现，现有引擎是横排折行 |
| ~~多图九宫格打卡~~ | ✅ 已完成 —— 1/2/3/4 张自适应网格，多图各自描边 |
| ~~EXIF 方向校正~~ | ✅ 已完成 —— 上传时转正并清 EXIF，渲染时兜底再校正 |
| 上传目录清理 | `public/uploads/` 会持续增长，需手工清理或加定时任务 |
| 图片缩略图 | 预览用原图，多张大会拖慢页面 |
| 提示词增强 | Qwen 官方的 PE 模型（`-PE-T2I` / `-PE-I2I`）未接入 |
| 登录 / 订阅 / Add On | 占位按钮，点击如实提示"未实现" |

**占位按钮不假装有功能** —— 点击会明确说明当前状态。

### AI 背景的硬件现实（RTX 5060 / 8 GB）

| 任务 | 预期 |
|---|---|
| 512×512 文生图 | ✅ 实测 72 秒（首次含加载 15 GB 权重） |
| 1024×1024 | 可跑，更慢；建议先 512 试通 |
| 2048 原生 2K | 需降分辨率或接受 VAE 分块瑕疵 |
| 改图 / 多参考图 | 很可能 OOM（8 GB 是硬瓶颈） |

省显存第一步是**换小编码器**（`qwen3vl_8b_w4a8.safetensors`，省 2.8 GB），
不是只压主干 —— 因为文本编码器（8B）比生成主干（7B）还大。

## 十、许可证（重要）

| 组件 | 许可 | 商用 |
|---|---|---|
| PosterForge 站点与渲染引擎 | MIT（本站代码） | ✅ 可以 |
| **Qwen-Image-2.1 权重** | **Qwen Research License** | ❌ **需单独授权** |

**Qwen-Image-2.1 仅限研究 / 非商业用途**（`model-business@notice.qwencloud.com`）。
上一代 Qwen-Image-2512 是 Apache-2.0，**2.1 不是** —— "Qwen 开源可商用"是过期印象。
社区 GGUF / 量化包同属衍生物，换格式不改变约束。

**实践含义**：给文旅局、酒店、饭馆出正式商业物料时，
海报**排版与文字合成**可以放心用；
若物料里含 **Qwen-Image-2.1 生成的背景图**，需先取得授权，
或改用可商用的托管模型 / 授权素材。
