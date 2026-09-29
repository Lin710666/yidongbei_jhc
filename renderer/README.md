# poster-forge

把**结构化文档**渲染成成品宣传物料。服务的四个群体：文旅局、酒店、饭馆、游客。

这是阶段 0 + 阶段 1 的可运行实现：**契约 + 渲染引擎 + 合规校验**，零 AI 依赖。

---

## 一、为什么这么设计（最重要的一节）

### 结论：别把"海报"当"一张图"，把它当"一份结构化文档"

**扩散模型画不准中文。** FLUX/SDXL 生成汉字基本是乱码或伪汉字。而 B2B 客户要的海报里，
"山海楼·海景大床房·￥688·含双早"错一个字就是事故。所以分工必须是：

```
LLM 产出 spec.json ──► 渲染引擎（PIL）──► 成品 PNG
                            ▲
                    AI 只负责「图像层」：背景生成 / 抠图 / 风格化
```

**文字、logo、二维码、价格永远走引擎层，永远不进模型。** 这样绕开了扩散模型最大的坑，
并顺带得到三个性质：可复现、可测试、可回滚。

### 推论：核心是一个纯函数

```python
render(spec: dict) -> Image    # 无 AI、无网络、无随机
```

- B2B 海报传 `layout=poster-vertical-gold`
- 游客打卡传 `layout=checkin-photo-card`

**同一套引擎，两个业务口都对上。** AI 只是"生成 spec"和"生成背景图"两个可替换适配器，
模型换代不动业务代码。

### 三个刻意的设计决定

| 决定 | 理由 |
|---|---|
| 所有几何用**画布比例**（0..1）而非像素 | 同一份 spec 可渲任意分辨率，改尺寸不用重排版 |
| 版式（layout）与内容（spec）**分离** | 换版式不改内容，换内容不改版式 |
| 色值走**调色板变量** | 换品牌色/换季只改一处；且令牌错误会被校验器拦下 |
| 文字用**引擎渲染**，AI 只出图像层 | 中文准确性是刚性需求 |

---

## 二、目录

```
poster-forge/
  render.py                      渲染器（图层栈 + 插槽）
  bg.py                          背景与调色板（单一职责，可独立测试）
  validate.py                    合规与结构校验器 ★ 别省这个
  schemas/poster-spec.schema.json  PosterSpec 契约（给 LLM 的输出约束）
  layouts/
    theme-deep-teal-gold.json     主题：深青金（酒店/政务）
    theme-sunset-warm.json        主题：暖橙（餐饮）
    poster-vertical-gold.json     版式：竖版 1080x1440
    banner-horizontal-warm.json   版式：横版 1200x628
    checkin-photo-card.json       版式：游客打卡 1080x1350
  specs/                          示例内容（LLM 该产出的东西）
  assets/sample-photo.png         程序化生成的示例照片
  out/                            成品 + 可追溯的 .spec.json
```

---

## 三、跑起来

```powershell
$py = 'E:\devenv\Scripts\python.exe'
cd E:\deepseck\poster-forge

# 1) 先校验（结构 + 颜色令牌 + 广告法）
& $py validate.py --spec specs\hotel-autumn.json

# 2) 再渲染
& $py render.py --spec specs\hotel-autumn.json

# 3) 覆盖尺寸出朋友圈方图（同一份 spec，不用重排版）
& $py render.py --spec specs\hotel-autumn.json --out out\square.png `
    --overrides '{"canvas":{"width":1080,"height":1080}}'
```

每次渲染会在 PNG 旁边落一份 `<名字>.spec.json` —— **物料可追溯**：这张图是用哪份 spec 渲的。

---

## 四、校验器查什么（B2B 物料的关键一关）

spec 由 LLM 产出，模型一定会犯三类错，而**这三类不需要渲染就能查**：

| 类别 | 例子 | 处理 |
|---|---|---|
| 结构错 | `type` 拼成 `textt`、缺 `box`、`font` 不存在 | error |
| 令牌错 | 用了调色板里没有的颜色名 | error（会静默出配色错误的图，最难查） |
| 合规错 | "全国第一"、"全市最低价"、编造的价格 | error |
| 资质表述 | "特级"、"独家"、"老字号" | warning，须人工确认 |
| 事实来源 | 含价格/电话但没标 `meta.facts_source` | error |

实测：一份故意埋了 6 类错误的 spec，校验器 7 个问题全部拦下。

> **每条产出都要过这一关。** LLM 一定会编造事实（房间数、开放时间、价格），
> 硬规则必须用代码而不是用模型来查。

---

## 五、已知问题与未做的事

**已在开发中踩到并修掉的坑（留作教训）：**

1. **参数语义错位（最严重）** —— 重构时 `make_background` 的形参被当成整个 spec，
   实际传入的是 background 字典，于是 `spec.get("theme")` 恒为 None，
   四个主题全部静默退化成默认青色。图看起来"正常"，所以极难发现。
   *教训：这个 bug 正是 `validate.py` 存在的理由 —— 令牌校验能提前拦下它。*
2. **静默降级** —— 颜色解析失败曾回落到默认色。现已改为直接报错。
   静默降级会把"主题没生效"伪装成一张配色错误的成品。
3. **`box` 两种写法** —— `[x0,y0,x1,y1]` 与 `{"box":[x,y],"size":[w,h]}`。
   曾只实现列表形式，dict 形式被当成 2 元素列表处理，拼出畸形字符串。
4. **PowerShell 改 UTF-8 文件** —— `Get-Content -Raw` 按 ANSI 读会写坏中文。
   本项目的文本替换一律走 Python。

**尚未实现（阶段 2 起）：**

- LLM 适配器：提示词 → spec.json（**这是下一步，且不需要下载任何图像模型**）
- 图像层 AI：背景生成、抠图去背（ComfyUI 接入点 = `background.type="image"` + `image` 图元）
- 二维码：装了 `qrcode` 才生效（`python -m pip install qrcode`）
- 中文竖排、多页 PDF 文案手册
- Web 服务与模板管理界面

---

## 六、下一步建议（顺序别倒）

**阶段 2：接 LLM 出 spec**
Ollama 下一个中文模型（如 `qwen3:8b`），只做"提示词 → spec JSON"这一件事。
背景先用纯色/渐变/客户提供的图。**此时不需要任何图像生成模型。**

**阶段 3：加图像生成**
到这一步才下载 FLUX，用途限定为"生成背景图"和"去背"，**不是生成整张海报**。

**为什么这个顺序**：阶段 1 结束就已经能给人看成品了，成本是 0 个模型下载。
倒过来先下模型，会在调 prompt 上耗掉一周，然后发现中文是乱码。

---

## 七、环境

- Python 3.10.21（`E:\devenv\Scripts\python.exe`），Pillow 12.3.0
- 字体走 `render.py` 的 `FONT_FILES` 表（微软雅黑 / 黑体 / 等线 / 华文中宋…），换机器只改这张表
- 无网络依赖，无 GPU 依赖
