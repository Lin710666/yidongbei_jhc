# Skill: image-layer（图像层 —— AI 出图的唯一合法接入点）

## 什么时候用

需要"版式里放一张客户没有的图"时：背景氛围图、场景示意图、去背后的实拍主体。

## 铁律

**AI 只出图像层，不出整张海报。**

原因：扩散模型画不准中文，而海报的文字准确性是刚性要求。
让模型生成含文字的整张海报 = 选错了技术路线。

合法接入点只有两个：

| 接入点 | 用法 |
|---|---|
| `background.type = "image"` | 生成的背景图铺底，文字与版式由引擎叠加 |
| `image` 图层 | 客户实拍图（可先去背）放进版式插槽 |

## 本地可用的出图能力（已部署）

**Qwen-Image-2.1**（7B，2026-09-21 开源），已下载到 `D:\ComfyUI-models`：

| 文件 | 大小 | 用途 |
|---|---|---|
| `diffusion_models\qwen_image_2.1_int8_convrot.safetensors` | 6.76 GB | 生成主干 INT8 |
| `text_encoders\qwen3vl_8b_int8_convrot.safetensors` | 8.71 GB | 文本编码器 INT8 |
| `vae\qwen_image_2.1_vae_bf16.safetensors` | 0.63 GB | VAE |

ComfyUI 0.37.0 原生支持，模板库搜 "Qwen Image 2.1" 有三个模板：
文生图 / 改图 / 去背景。

### 它在海报流程里的两个用途

1. **背景生成**：出一张无文字的氛围背景（如"海边日落，虚化，适合压深色文字"），
   存成 `assets/bg-*.png`，写进 spec 的 `background.image`
2. **去背景**：用 "Remove Background" 模板处理客户实拍图，
   输出 PNG（带 alpha），放进 `image` 图层的 `src`

**它不负责**：排版、文字、价格、二维码、logo。

## 硬件预期（RTX 5060 8 GB 实测约束）

| 任务 | 预期 |
|---|---|
| 1024×1024 文生图 | 可以，用 `--lowvram` 启动参数 |
| 2048 原生 2K | 需降分辨率，或接受 VAE 分块瑕疵 |
| 改图 / 多参考图 | **很可能 OOM**，8 GB 是硬瓶颈 |

显存特点：**文本编码器（8B）比生成主干（7B）还大**。
省显存先换小编码器 `qwen3vl_8b_w4a8.safetensors`（5.88 GB），不是只压主干。

启动参数（沿用已有的低显存脚本）：

```
python_embeded\python.exe -s ComfyUI\main.py ^
  --lowvram --use-pytorch-cross-attention ^
  --disable-smart-memory --reserve-vram 0.4 --cache-none --port 8188
```

## 许可证（必须向客户说明）

**Qwen-Image-2.1 权重采用 Qwen Research License Agreement —— 仅限研究 / 非商业用途。**

- 上一代 Qwen-Image-2512 是 Apache-2.0，**2.1 不是**。"Qwen 开源可商用"是过期印象。
- 社区 GGUF / 量化包同属衍生物，受同一许可约束，**换格式不改变约束**。
- 商用需单独授权：`model-business@notice.qwencloud.com`

**推论**：海报排版与文字合成（本站代码）可商用；
但**用 Qwen-Image-2.1 生成的背景图**不得直接用于给客户交付的商业物料，
除非取得授权。需要商用图像层时，改用可商用的托管模型或授权素材。

## 交付判定

- 生成的背景图**不含文字**（文字一律由引擎叠加）
- 记录用了哪个模型、什么提示词、什么许可证（写进物料归档）
- 交付给客户前核对该模型是否允许本次用途
