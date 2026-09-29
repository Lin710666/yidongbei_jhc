# Skill: compliance-check（校验把关）

## 什么时候用

**每一份物料在出图之前。** 这是流程里唯一"不能省"的一步。

## 为什么必须用代码而不是模型

模型一定会犯三类错，而这三类**不需要渲染就能查**：

| 类别 | 例子 | 后果 |
|---|---|---|
| 结构错 | `type` 拼成 `textt`、缺 `box`、`font` 不存在 | 渲染时才报错，浪费一次调用 |
| 令牌错 | 用了调色板里没有的颜色名 | **静默出配色错误的图** —— 看起来正常，最难查 |
| 合规错 | "全国第一""全市最低价"、编造的价格 | 业务事故，会被投诉和处罚 |
| 资质表述 | "特级""独家""老字号" | 需人工确认资质 |
| 事实来源 | 含价格/电话但没标 `facts_source` | 无法追溯到客户确认 |

**用模型查模型是错的**：查合规要的是"稳定的判定"，不是"又一次生成"。

## 怎么用

```powershell
$py = 'E:\devenv\Scripts\python.exe'
cd E:\deepseck\poster-forge

# 单份
& $py validate.py --spec specs\client-x.json

# 严格模式：有 warning 也判失败（正式交付建议开）
& $py validate.py --spec specs\client-x.json --strict

# 批量：对所有 spec 跑一遍
Get-ChildItem specs\*.json | ForEach-Object {
  & $py validate.py --spec $_.FullName
  if ($LASTEXITCODE -ne 0) { Write-Host "未通过: $($_.Name)" -ForegroundColor Red }
}
```

退出码：`0` 通过 / `1` 有 error / `2` 文件问题。

## 广告法禁用与高风险词表

命中即 **error**（《广告法》第九条等）：

```
国家级 世界级 最高级 最佳 最好 最优 最强 最便宜 最低价
第一品牌 全国第一 全市第一 销量第一 排名第一
绝无仅有 独一无二 百分百 100% 永久 根治 特效
国家免检 免检产品 央视上榜
```

命中即 **warning**（需资质证明）：

```
特级 极品 首家 独家 领先 权威 驰名商标 老字号
```

词表在 `poster-forge/validate.py` 的 `AD_LAW_BANNED` / `AD_LAW_NEEDS_PROOF`，
按行业实际需要增补。

## 把校验报告回喂给模型

接 LLM 时的推荐闭环：

```
LLM 出 spec → validate.py
                ├─ 通过 → render.py
                └─ 不通过 → 把 error 原文拼进下一轮提示词，要求模型只改被指出的问题
```

限制重写轮数（建议 2 轮），超过就转人工 —— 否则会陷入模型反复改不对的循环。

## 交付判定

- `validate.py` 退出码为 0
- 正式交付额外要求 `--strict` 通过（无 warning）
- 报告随物料一起归档
