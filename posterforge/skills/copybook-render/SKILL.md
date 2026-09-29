# Skill: copybook-render（多页 PDF 文案手册）

## 什么时候用

客户要的不是"一张海报"，而是**一份能发出去、能打印、能存档的文档**：
产品手册、活动手册、招商资料、菜单册。**特征：有阅读顺序，跨页要统一。**

## 与海报 skill 的根本差别

| 维度 | 海报（`render-pipeline`） | 手册（本 skill） |
|---|---|---|
| 载体 | 单张 PNG | 多页 PDF |
| 组织 | 图层栈（谁压谁） | 章节序列（谁接谁） |
| 关键概念 | 插槽 position | **阅读节奏** + 分页 + 页眉页脚 |
| 渲染器 | `poster-forge/render.py` | `site/copybook.py` |
| 尺寸 | 任意画布 | A4 竖版，300 DPI（2481×3507） |

**共同点**：文字同样走确定性排版，不经过图像模型；色板同样走调色板变量。

## 版块类型

| type | 用途 | 关键字段 |
|---|---|---|
| `cover` | 封面（满幅渐变） | `eyebrow` `title` `subtitle` `footer` |
| `text` | 正文段落 | `heading` `lead` `body[]` |
| `bullets` | 卖点列表（左侧强调块） | `items[{head, body}]` |
| `table` | 规格/价格表（隔行浅底） | `columns[]` `rows[][]` |
| `price` | 价格页（深色强调页） | `note` `price` `unit` `includes[]` |
| `contact` | 联系方式页（深色强调页） | `title` `items[{k,v}]` `qr_note` |

## 色板要求（比海报多一组"纸面"色）

手册有两种页面底色，所以调色板要两套：

```json
"theme": { "palette": {
  "bgFrom": "#0b2a30", "bgTo": "#1d5f66", "panel": "#08202a",
  "ink": "#ffffff", "inkSoft": "#d6ecec", "inkMute": "#9fc4c6",
  "gold": "#e8c37a", "divider": "#ffffff2e",

  "paper": "#faf8f5",
  "inkOnPaper": "#1e1a17",
  "inkMuteOnPaper": "#57504a",
  "accentOnPaper": "#b98b3f",
  "dividerOnPaper": "#00000022",
  "zebra": "#00000010"
} }
```

深色页（cover/price/contact）用第一组，浅色页（text/bullets/table）用第二组。
**浅色页不是"深色反相"** —— 长文阅读需要低对比、暖白底，直接反相会很刺眼。

## 怎么用

```powershell
$py = 'E:\devenv\Scripts\python.exe'
cd E:\deepseck\site

# 出 PDF
& $py copybook.py --spec specs\copybook-hotel-autumn.json --out out\book.pdf

# 同时导出每页 PNG（便于逐页检查排版）
& $py copybook.py --spec specs\copybook-hotel-autumn.json `
    --out out\book.pdf --png-dir out\book-pages
```

站点侧通过 `POST /api/copybook` 调用，返回
`{ ok, url, pages[], pageCount, bytes }` —— `pages[]` 用于前端缩略图预览。

## 实测性能

| 环节 | 耗时 |
|---|---|
| 6 页 A4 @ 300 DPI | ~3 秒 |
| PDF 体积 | 约 2.2 MB（6 页） |
| 单页 PNG 预览 | 约 150–440 KB/页 |

## 阅读节奏建议（内容层的事，不是渲染的事）

手册好不好用，一半取决于章节顺序。推荐骨架：

```
封面          → 建立印象（大标题 + 一句话价值）
正文导语      → 交代背景（为什么有这份东西）
卖点列表      → 展开价值（3–5 条，每条一句标题 + 一句说明）
规格/价格表   → 给决策依据（表格化，便于横向对比）
价格强调页    → 收束（大字价格 + 包含项）
联系方式      → 行动入口（电话/地址/有效期）
```

**常见错误**：把海报内容直接堆成多页。手册的每一页要有**独立的阅读任务**，
不是把一张图切成几块。

## 交付清单

- [ ] 页眉含客户名与文档名，页脚含生成方与页码
- [ ] 价格、电话、地址与客户确认信息一致（对照 `meta.facts_source`）
- [ ] 有效期写在封面或联系页
- [ ] 表格数据与客户提供的一致，无编造
- [ ] 归档 PDF + 源 spec（改价时直接改 spec 重渲）

## 已知限制

- **无竖排、无图文混排**：目前只有纯文字版块，插图片到手册里未实现
- **无自动分页**：一个版块固定一页，文字超出会溢出而不换页
- **无目录页 / 无页脚页码交叉引用**
- 表格**不支持单元格内换行**（长文本会溢出列宽）
- 不支持自定义页面尺寸（固定 A4 竖版）

## 校验（已具备）

用 `poster-forge/validate-copybook.py`，支持 `--json` 供服务端调用：

```powershell
$py = 'E:\devenv\Scripts\python.exe'
& $py ..\poster-forge\validate-copybook.py --spec specs\book.json
& $py ..\poster-forge\validate-copybook.py --spec specs\book.json --json
& $py ..\poster-forge\validate-copybook.py --spec specs\book.json --strict
```

查五类问题，**都不需要渲染**：

| 类别 | 查什么 |
|---|---|
| 结构 | 必填字段、版块类型、类型专属字段（table 列数一致、contact 的 k/v 齐全） |
| 调色板 | **按实际用到的页面类型**判断缺哪些色名（深色页/浅色页/封面渐变分开要求） |
| 合规 | 广告法禁用词、需资质表述、含价格电话但无 `facts_source` |
| 引用 | `meta.logo` / `sections[].image` 指向的文件是否存在 |
| 跨页一致 | 同一门店的电话在多页是否一致（号码归一化后比对） |

**广告法词表从 `validate.py` 导入，不复制** —— 两处维护必然漂移。

实测：一份埋了 9 类错误的 spec，校验器报出 **13 error / 3 warning**，全部命中。

服务端 `/api/copybook` 已改为**先校验后渲染**：不通过则返回 422 与逐条报告，
不会浪费一次渲染，前端会把报告逐条展示给用户。

### 一个值得记下的坑

`python.exe` 输出到**管道**时默认用系统 ANSI 编码（中文 Windows 上是 GBK），
而 Node 按 UTF-8 读 —— 校验器的中文报错会全变成乱码方块。
在终端手跑永远不会暴露，只有作为子进程被读输出时才会。

服务端 `run()` 里已显式设置 `PYTHONIOENCODING=utf-8` 与 `PYTHONUTF8=1`。
