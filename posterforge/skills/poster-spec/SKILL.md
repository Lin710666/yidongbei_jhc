# Skill: poster-spec（契约层）

## 什么时候用

任何需要「生成一张海报 / 打卡卡」的场景。这是所有物料类 skill 的**共同底座** ——
无论文旅局、酒店、饭馆还是游客，产出物最终都是一份 PosterSpec。

## 职责

1. 定义 PosterSpec 的字段与语义（`references/poster-spec.schema.json`）
2. 定义图层命名与插槽约定（`references/layer-naming.md`）
3. 列出可用版式与其适用范围（`references/layouts.md`）

## 不做的事

- **不生成像素**。像素由 `render-pipeline` 负责。
- **不校验合规**。合规由 `compliance-check` 负责。
- 不决定文案写什么。文案由业务 skill（`hotel-promo` 等）决定。

## 核心概念

### 画布比例而非像素

所有几何值都是**画布比例（0..1）**，不是像素：

```json
{ "box": { "box": [0.068, 0.106], "size": [0.864, 0.522] } }
```

好处：同一份 spec 可以渲任意分辨率。出 1080×1440 竖版和 1080×1080 方图不用重排版。

`box` 有两种等价写法，别混用：

| 写法 | 含义 |
|---|---|
| `[x0, y0, x1, y1]` | 四元素数组：左上角 + 右下角 |
| `{ "box": [x, y], "size": [w, h] }` | 对象：左上角 + 宽高 |

### 调色板变量而非色值

图层里**优先写调色板变量名**，色值只在 `theme.palette` 定义一次：

```json
"theme": { "palette": { "gold": "#e8c37a", "ink": "#ffffff" } },
"layers": [{ "type": "text", "color": "gold" }]
```

好处：换品牌色/换季只改一处。**且变量名写错会被校验器拦下** —— 若直接写死色值，
写错只会得到一张配色奇怪的图，很难查。

### 版式与内容分离

`layout` 引用提供骨架，`layers` 提供内容：

```json
{ "layout": "@layout:poster-vertical-gold", "layers": [ ... ] }
```

合并规则：dict 递归合并，list 与标量整体替换（所以 `layers` 会完整覆盖骨架里的占位图层）。

### 文字永不进模型

文本内容只存在于 JSON 里，由渲染引擎排版。
**不要**把提示词里的文字交给扩散模型去画 —— 中文必然出错。

## 事实字段必须可回溯

`meta.facts_source` 记录价格 / 电话 / 地址 / 房间数等事实的来源。
字段缺失时 `compliance-check` 会报错。

```json
"meta": {
  "id": "hotel-2026-autumn-01",
  "client": "山海楼·海景度假酒店",
  "audience": "hotel",
  "intent": "秋季错峰促销 · 三晚连住",
  "facts_source": "客户 2026-09-23 微信口述 + 官网房价页截图，价格经客户确认"
}
```

## 快速自检

```powershell
& 'E:\devenv\Scripts\python.exe' scripts\check-spec.py ..\..\..\poster-forge\specs\hotel-autumn.json
```

## 交付判定

- JSON 能被 `poster-forge/validate.py` 无 error 通过
- `meta.facts_source` 已填且与内容相符
- 所有颜色字段要么是 `#RRGGBB`，要么是 `theme.palette` 里存在的键
- 所有 `image` 图层的 `src` 文件真实存在
