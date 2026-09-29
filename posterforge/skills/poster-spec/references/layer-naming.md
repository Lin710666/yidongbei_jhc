# 图层命名与插槽约定

沿用 `psd2live` 那套经过实测的命名规则（中英日三语别名、`-l`/`-r` 左右后缀），
让同一份内容能在"海报版式"与"Live2D 拆图流水线"之间复用。

## 左右后缀

分类器支持：`-l` `-r` `_l` `_r` `left` `right` `左` `右`，以及括号形式 `(l)`。

**左右指角色自身**：角色左侧在画面**右边**。这条容易搞反，写死后要人工核一遍。

## 标准插槽名

### 营销物料（海报 / 横幅）

| 插槽名 | 内容 | 备注 |
|---|---|---|
| `brand` | 品牌名 | 顶部主识别 |
| `brandEn` | 品牌英文名 | 副行 |
| `eyebrow` | 副标题 / 活动定语 | 如"错峰特惠 · 限量 200 间" |
| `title` | 主标题 | 字号最大，支持 `\n` 硬换行 |
| `subtitle` | 卖点罗列 | 2–3 行，用 `·` 分隔 |
| `priceNote` | 价格说明 | 如"三晚连住 · 每晚均价" |
| `price` | 价格数字 | 必须来自客户，不得生成 |
| `phone` | 电话 | 事实字段 |
| `address` | 地址 | 事实字段 |
| `footerNote` | 页脚声明 | 有效期、以门店公告为准等 |
| `qr` | 二维码 | 需 `pip install qrcode` |

### 人物部件（Live2D / 立绘）

| 插槽名 | 识别为 |
|---|---|
| `back hair` / `front hair` / `side hair-l` / `side hair-r` | 后发 / 前发 / 侧发 |
| `face` | 脸 |
| `eyebrow-l` / `eyebrow-r` | 眉毛 |
| `eye white-l` / `eye white-r` | 眼白 |
| `irides-l` / `irides-r` | 瞳孔 |
| `eyelash-l` / `eyelash-r` | 上睫毛 |
| `nose` / `mouth` / `mouth open` | 鼻 / 闭嘴 / 最大张口 |
| `neck` | 脖子 |
| `topwear` / `bottomwear` | 上衣 / 下装 |
| `handwear-l/r` / `legwear-l/r` / `footwear-l/r` | 手臂 / 腿 / 鞋 |
| `hat` / `accessory` | 帽子 / 配饰 |

## 命名禁忌

1. **PSD 图层名不能用中文**（旧式 Pascal string 走 mac_roman 编码会抛 `UnicodeEncodeError`）。
   我们的 JSON spec 里**可以**用中文——`name` 字段只是内部标识，不写进 PSD。
2. **隐藏图层不会进模型**。想做"随参数切换"，要保持可见，再设差分。
3. 同一角色左右对称件**允许同名**（靠左右后缀区分），但不要出现两个完全同名的部件。
