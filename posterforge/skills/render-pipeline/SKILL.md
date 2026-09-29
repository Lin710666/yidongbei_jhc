# Skill: render-pipeline（合成层）

## 什么时候用

校验通过之后，把 spec 变成成品像素。也可用于批量出图、多尺寸分发。

## 核心保证

```python
render(spec) -> Image
```

**纯函数**：无 AI、无网络、无随机。同样的 spec 永远得到同样的像素。
由此得到三个性质：可复现、可测试、可回滚。

## 怎么用

```powershell
$py = 'E:\devenv\Scripts\python.exe'
cd E:\deepseck\poster-forge

# 基本
& $py render.py --spec specs\hotel-autumn.json

# 指定输出
& $py render.py --spec specs\hotel-autumn.json --out out\v2.png

# 多尺寸分发：同一份内容，不改版式
& $py render.py --spec specs\hotel-autumn.json --out out\square.png `
    --overrides '{"canvas":{"width":1080,"height":1080}}'

# 微信朋友圈 9:16 竖屏
& $py render.py --spec specs\hotel-autumn.json --out out\story.png `
    --overrides '{"canvas":{"width":1080,"height":1920}}'
```

## 产出约定

输出 PNG 的同名位置会落一份 `<名字>.spec.json`：**这张图是用哪份 spec 渲的**。
归档时两者一起收，物料可追溯 —— 半年后要改价，直接改 spec 重渲即可。

## 单份 vs 批量

批量场景不用反复起进程，直接在 Python 里调：

```python
import sys, json
sys.path.insert(0, r"E:\deepseck\poster-forge")
import render as R

for name in ["hotel-autumn", "restaurant-lunch"]:
    raw = json.load(open(rf"E:\deepseck\poster-forge\specs\{name}.json", encoding="utf-8"))
    img = R.render(R.build_spec(raw))
    img.save(rf"E:\deepseck\poster-forge\out\{name}-batch.png")
```

## 多尺寸适配的边界

同一份 spec 换画布尺寸时，**比例类版式**能自动适应（文字自动折行缩号），
但**为特定比例设计的版式**换比例后会显得空或挤。建议：

| 目标 | 建议做法 |
|---|---|
| 同比例不同分辨率 | 直接 `--overrides`，安全 |
| 竖版 → 方图 | 可以，检查留白 |
| 竖版 → 横版 | **换版式**，不要硬撑。横版有专门的 `banner-horizontal-warm` |

## 性能参考（实测）

| 环节 | 耗时 |
|---|---|
| 冷启动（Python + Pillow 导入） | ~0.4 秒 |
| 渲染 1080×1440 | ~0.3 秒 |
| 端到端（HTTP → 校验 → 渲染 → 落盘） | **~0.8 秒** |

比任何图像模型都快几个数量级 —— 因为这是纯 CPU 合成，不是采样。

## 已知限制

- 中文竖排未实现
- 多页 PDF 输出未实现（文案手册需要另写渲染器）
- 二维码需 `pip install qrcode`，未装时会在 stderr 明确警告并跳过该图元
- `import` 图片路径相对 `poster-forge/` 解析，绝对路径也可

## 踩过的坑：`fit.maxWidth` 曾被忽略（已修）

`draw_text` 早期只读**元素级** `maxWidth`，完全没读 `fit.maxWidth`。于是这种写法无效：

```json
{ "type": "text", "text": "很长的句子", "fit": { "maxWidth": 0.864, "maxLines": 3 } }
```

后果是长句不折行，**直接溢出画布被裁掉** —— 实测"风大记得带外套"被切成"风大记"。
**裁剪比缩小字号严重得多**：它是静默丢内容，用户看不到自己写的东西。

修法两条：
1. `maxWidth` 现在从元素级与 `fit` **两处都读**
2. 加了兜底：若仍有行超出宽度，逐像素缩小字号直到放得下

教训：**"写在两个地方都该生效"的字段，必须两处都读**。
只实现一处时不会报错，只会静默产出错误的图。
