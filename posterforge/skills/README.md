# PosterForge Skill 工作流

> ## ⚠️ 先看这里：本目录已不再是"生效中的 skill"
>
> 从 2026-09-28 起，**DSH 自动调用的 skill 全部搬到了 `E:\deepseck\.dsh\skills\`**，
> 共 17 个，都带 YAML frontmatter（`name` + `description`），
> 由 agent 按任务自动检索并注入。
>
> **为什么必须搬**：agent 只扫描 `.dsh/skills`、`.agents/skills`、`~/.dsh/skills`
> 这几个根目录，**不扫 `site/skills`**；而且没有 frontmatter 的 markdown
> 会被直接忽略（连 `name` 都没有，无从匹配任务）。所以本目录原来的 12 份文档
> 虽然内容不错，却**从来没有被自动调用过**。
>
> **现在两边的关系**：
>
> | 位置 | 作用 |
> |---|---|
> | `.dsh\skills\` | **生效中的 skill** —— agent 自动加载，改这里才有行为变化 |
> | `site\skills\`（本目录） | **历史设计文档** —— 保留作参考，不再被自动加载 |
>
> 本目录里的 `references/` 子文档（词表、尺寸表、模板、schema）
> 已**原样复制**到对应的新 skill 目录下，继续随 skill 一起被读取。
>
> 校验新 skill 是否合规：
>
> ```powershell
> node E:\deepseck\.dsh\check-skills.mjs
> ```
>
> 改 skill 内容请改 `.dsh\skills\` 那一份；改本目录不会影响 agent 行为。

---

本目录定义「从客户需求到可发布物料」的完整能力契约。整套东西服务四类对象：

| 对象 | 输入 | 产出 |
|---|---|---|
| 文旅局 | 提示词、官方图片、政务模板 | 活动海报、宣传手册 |
| 酒店 | 提示词、实拍图、房价 | 促销海报、OTA 图 |
| 饭馆 | 提示词、菜品图、菜单 | 套餐海报、外卖头图 |
| 游客 | 对话、照片 | 打卡模板（可发小红书/朋友圈） |

---

## 一、核心设计决定（为什么这么分层）

**海报不是"一张图"，是"一份结构化文档"。**

扩散模型画不准中文。B2B 客户的海报里，"￥688·含双早"错一个字就是事故。
所以能力被拆成三层，**AI 只在最外层**：

```
① 契约层（spec 定义）      ← 稳定，模型换代不影响
      ↓
② 决策层（LLM 产出 spec）   ← 可替换：本地 Ollama / 在线 API / 人工
      ↓
③ 合成层（确定性渲染）      ← 稳定，可复现、可测试、可回滚
      ↕
   （旁路）图像层：背景生成 / 抠图   ← 可替换：ComfyUI / 云端 / 不用
```

**收益**：换模型不动业务代码；同样的 spec 永远得到同样的像素；
文字、价格、二维码、logo 永远走确定性合成，不经过模型。

---

## 二、技能清单

| Skill | 职责 | 关键产物 | 状态 |
|---|---|---|---|
| [`poster-spec`](poster-spec/SKILL.md) | **契约层**：定义 PosterSpec 结构与图层命名约定 | `poster-spec.schema.json` | ✅ |
| [`compliance-check`](compliance-check/SKILL.md) | **把关**：广告法、事实来源、结构、颜色令牌 | 校验报告 | ✅ |
| [`validate-copybook`](copybook-render/SKILL.md) | **手册把关**：结构/调色板/合规/跨页一致 | 逐条校验报告 | ✅ 新增 |
| [`render-pipeline`](render-pipeline/SKILL.md) | **合成层**：spec → 成品 PNG | 确定性渲染 | ✅ |
| [`copybook-render`](copybook-render/SKILL.md) | **文档层**：多页 PDF 文案手册 | A4 多页 PDF | ✅ 新增 |
| [`photo-upload`](photo-upload/SKILL.md) | **输入层**：照片上传与字节校验 | 可用的图片路径 | ✅ 新增 |
| [`bureau-poster`](bureau-poster/SKILL.md) | 文旅局：政务/活动物料 | 海报 + 手册 | ✅ |
| [`hotel-promo`](hotel-promo/SKILL.md) | 酒店：促销物料 | 海报 + 多尺寸 | ✅ |
| [`restaurant-promo`](restaurant-promo/SKILL.md) | 饭馆：套餐/外卖物料 | 海报 + 头图 | ✅ |
| [`tourist-checkin`](tourist-checkin/SKILL.md) | 游客：对话+照片 → 打卡卡 | 打卡模板 | ✅ |
| [`image-layer`](image-layer/SKILL.md) | **图像层**：背景生成 / 抠图 | 背景图 / 去背图 | ✅ 实测 |

---

## 三、四步链路

```
① 需求录入 ──► ② 契约生成 ──► ③ 校验把关 ──► ④ 合成出图
   收集素材        LLM 出 spec      validate.py      render.py
   标注事实来源     （可人工写）      不通过就退回      落 spec 存档
```

**第 ① 步的铁律**：价格、电话、地址、房间数、开放时间这类**事实字段必须来自客户输入**，
并记录在 `meta.facts_source` 里。模型不得生成这类内容 —— 这是 `compliance-check` 会强查的。

**第 ③ 步不可省**。模型一定会犯三类错，而且都不需要渲染就能查出来：

- 结构错（字段名拼错、类型不对）
- 令牌错（用了调色板里不存在的颜色名）→ 表现为"静默出配色错误的图"，最难查
- 合规错（"全国第一""全市最低价"）→ 业务事故，不是渲染瑕疵

---

## 四、最小可用流程（手工版，不需要 LLM）

即使不接模型，这套流程今天就能用：

```powershell
$py = 'E:\devenv\Scripts\python.exe'
cd E:\deepseck\poster-forge

# 1) 抄一份示例 spec 改成客户内容
copy specs\hotel-autumn.json specs\client-x.json

# 2) 校验
& $py validate.py --spec specs\client-x.json

# 3) 渲染
& $py render.py --spec specs\client-x.json --out out\client-x.png

# 4) 同一份内容出朋友圈方图（版式不用重排）
& $py render.py --spec specs\client-x.json --out out\client-x-square.png `
    --overrides '{"canvas":{"width":1080,"height":1080}}'
```

产出旁边会落一份 `<名字>.spec.json` —— **物料可追溯**：这张图是用哪份 spec 渲的，改了什么一目了然。

---

## 五、接 LLM 的位置

LLM 只做一件事：**把客户的话变成 spec JSON**。它不碰像素。

契约在 `poster-spec/posterspec.schema.json`，把它作为结构化输出约束喂给模型即可。
建议流程：

1. 客户对话 / 提示词 → 用 `bureau-poster` 等业务 skill 的提示词模板
2. LLM 输出 spec JSON
3. **必须**过 `compliance-check`
4. 通过后交 `render-pipeline` 出图；不通过则把校验报告回喂给模型重写

这样即使模型换了、或改用在线 API，第 3、4 步完全不用动。

---

## 六、接图像层的位置

AI 出图**只在两个位置**合法接入，别的地方都不该用：

1. `background.type = "image"`：背景图由 ComfyUI / 云端生成后放进版式
2. `image` 图层：客户实拍图（可先去背）放进版式

**绝不让模型生成整张海报**（含文字）——那是错的技术路线。

---

## 七、已实现（2026-09 补齐）

| 能力 | 实现位置 | 实测 |
|---|---|---|
| 照片上传 | `POST /api/upload`（base64 + 魔数校验） | 60 KB 照片落盘；伪造文件被拒 |
| 照片 → 打卡卡 | 上传路径写进 spec，渲染器多根解析 | 走 UI 实点，结果标注"使用上传照片" |
| 多页 PDF 手册 | `site/copybook.py` + `POST /api/copybook` | 6 页 A4，2.18 MB，约 3 秒 |
| AI 背景生成 | `site/comfy.mjs` + `POST /api/comfy/background` | Qwen-Image-2.1 在 8 GB 显存跑通 |
| **手册校验器** | `poster-forge/validate-copybook.py` | 埋错 spec 报出 13 error / 3 warning；服务端先校验后渲染 |

**ComfyUI 接入说明**：工作流用**官方模板的真实拓扑**
（`image_qwen_image_2_1_t2i.json` 的子图），节点为
`UNETLoader → TextEncodeQwenImage21 → KSampler → VAEDecode → SaveImage`。
客户端的提交/轮询/取图链路已用轻量工作流单独验证过。

## 八、已知边界（仍未做）

- **中文竖排**未实现（现有引擎是横排折行）
- **手册图文混排与自动分页**未实现：一个版块固定一页，文字超出会溢出而不换页
- **二维码**需要 `pip install qrcode` 才生效
- **上传目录无自动清理**：`site/public/uploads/` 会持续增长
- **多图九宫格**打卡版式未实现（当前只支持单图）
- **EXIF 方向校正**未做：手机竖拍的照片可能显示为横的

## 九、许可证边界（重要）

海报**排版与文字合成**是本站自己的代码，可商用。

若接入 **Qwen-Image-2.1** 生成背景图：该模型权重采用
**Qwen Research License（仅限研究 / 非商业用途）**。
给文旅局、酒店、饭馆出**正式商业物料前，必须先取得单独商业授权**
（`model-business@notice.qwencloud.com`）。

社区 GGUF / 量化包同属衍生物，**换格式不改变许可证约束**。
