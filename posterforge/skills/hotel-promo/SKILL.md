# Skill: hotel-promo（酒店）

## 服务对象与场景

星级酒店、度假村、民宿。典型需求：房型促销、套餐预售、节日活动、
OTA 头图、私域社群物料。**特征：价格是核心，需清晰可核对。**

## 提示词模板

```
你是酒店营销物料编辑。根据以下素材产出物料内容。

【硬性约束】
1. 房型名称、价格、有效期、电话、地址必须逐字使用我提供的信息。
2. 房价必须写清"含/不含"什么（早餐、税费、服务费），不得含糊。
3. 不得使用"最"字类表述（最低价/最豪华/全市最好）—— 违反《广告法》。
4. 不得承诺我未提供的服务（如"保证升级""免费加床"）。
5. "限量""仅剩"类表述必须有真实库存依据，否则不写。

【素材】
酒店名称：{{name}}
房型：{{room_type}}
套餐内容：{{package}}     ← 逐条列出，如"含双早 / 免费停车 / 赠双人温泉"
价格与说明：{{price}}     ← 如"三晚连住 · 每晚均价 ￥688"
有效期：{{validity}}
预订电话：{{phone}}
地址：{{address}}

【输出】
PosterSpec JSON。price 字段只放数字与货币符号，说明性文字放 priceNote。
```

## 版式与主题

| 用途 | 版式 | 主题 |
|---|---|---|
| 促销海报（竖版） | `poster-vertical-gold` | `teal` 深青金 / `ink` 高级灰 |
| 雪季 / 温泉 | `poster-vertical-gold` | `ink` 或 `midnight` |
| 海岛 / 民宿 | `poster-vertical-gold` | `midnight` 深蓝 / `pine` 松绿 |
| OTA 头图 | `banner-horizontal-warm` | 按季节 |

**关键版式要素**：价格必须落在 `pricePanel` 里（深色底板 + 左侧强调色条），
这是这套模板最容易被记住的部分，也是客户最在意的信息。

## 多尺寸分发

酒店物料通常要同时出多份，同一份 spec 改画布即可：

```powershell
$py = 'E:\devenv\Scripts\python.exe'
$s = 'specs\hotel-x.json'
& $py render.py --spec $s --out out\hotel-x-vertical.png      # 1080×1440 海报
& $py render.py --spec $s --out out\hotel-x-square.png  --overrides '{"canvas":{"width":1080,"height":1080}}'
& $py render.py --spec $s --out out\hotel-x-story.png   --overrides '{"canvas":{"width":1080,"height":1920}}'
& $py render.py --spec $s --out out\hotel-x-ota.png     --overrides '{"canvas":{"width":1200,"height":628}}'
```

OTA 横图（竖→横）**建议换版式**，不要硬撑竖版骨架。

## 交付清单

- [ ] `validate.py` 通过
- [ ] 房价、有效期、电话与客户确认信息逐字一致（对照 `meta.facts_source`）
- [ ] "含/不含"表述明确
- [ ] 有效期已写进 `footerNote` 或 `priceNote`
- [ ] 无"最"字类表述
- [ ] 归档 spec + 各尺寸成品

## 常见坑

| 坑 | 说明 |
|---|---|
| 价格含糊 | "￥688 起" 的"起"字极易引发投诉，除非确有更低房型，否则别加 |
| 有效期漏写 | 促销物料必写，否则过期后仍在传播 |
| 房型写错 | 大床房 / 双床房 / 家庭房 必须与客户确认，这是最常见的投诉来源 |
| 温泉类表述 | "温泉"有资质要求，若为加热水需如实表述 |
