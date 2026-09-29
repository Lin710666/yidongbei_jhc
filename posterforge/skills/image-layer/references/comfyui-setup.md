# ComfyUI 接入说明（本机实测环境）

## 已部署环境

| 项 | 值 |
|---|---|
| ComfyUI | 0.37.0（便携版） |
| 路径 | `E:\ComfyUI_windows_portable` |
| Python | 3.13.14（内嵌） |
| torch | 2.13.0+cu130，CUDA 可用 |
| 显卡 | RTX 5060 / 8 GB |
| 模型根目录 | `D:\ComfyUI-models`（已挂进 `extra_model_paths.yaml`） |
| 端口 | 8188 |

## Qwen-Image-2.1 已下载的文件

| 文件 | 大小 |
|---|---|
| `D:\ComfyUI-models\diffusion_models\qwen_image_2.1_int8_convrot.safetensors` | 6.76 GB |
| `D:\ComfyUI-models\text_encoders\qwen3vl_8b_int8_convrot.safetensors` | 8.71 GB |
| `D:\ComfyUI-models\vae\qwen_image_2.1_vae_bf16.safetensors` | 0.63 GB |

模板库搜 **"Qwen Image 2.1"**，三个模板：文生图 / 改图 / 去背景。

## 启动（8 GB 显存必须用低显存参数）

用现成的 `启动ComfyUI-低显存.bat`，等价命令：

```
python_embeded\python.exe -s ComfyUI\main.py ^
  --lowvram --use-pytorch-cross-attention ^
  --disable-smart-memory --reserve-vram 0.4 --cache-none ^
  --port 8188
```

各参数作用：
- `--lowvram`：权重复用时换入换出，不常驻显存
- `--use-pytorch-cross-attention`：用 PyTorch SDPA 省显存内核
- `--disable-smart-memory`：禁用头释放策略
- `--reserve-vram 0.4`：留 0.4 GB 给系统
- `--cache-none`：不缓存中间结果，省内存

**改 `extra_model_paths.yaml` 后必须重启 ComfyUI 才生效。**

## 采样参数（模板默认，别照 Diffusers 改）

```
steps 25 · cfg 1 · sampler euler · scheduler simple
目标约 4.0 MP（2048×2048）
```

**8 GB 显存第一次跑先把分辨率降到 1024×1024**，确认能出图再往上加。

## 8 GB 显存的真实边界

| 任务 | 预期 |
|---|---|
| 1024×1024 文生图 | 大概率可以 |
| 2048 原生 2K | 需降分辨率，或接受 VAE 分块瑕疵 |
| 改图 / 多参考图 | **很可能 OOM**（有 8 GB 用户用 Q4_K_M 改图崩溃的记录） |

显存特点：**文本编码器（Qwen3-VL 8B）比生成主干（7B）还大**。
省显存第一步是换小编码器 `qwen3vl_8b_w4a8.safetensors`（5.88 GB），不是只压主干。

单个光斑/背景图建议尺寸：**不超过 1536×1536**，再大就为海报做无谓开销。

## 在 poster-forge 流程里怎么用

**只做两件事**：生成背景、去背。不出整张海报。

### 1. 生成背景

```
提示词示例：
  海边日落，暖橙与深青渐变，虚化远景，画面下半部留空，
  适合压深色文字，无文字，无 logo
```

产出存为 `assets/bg-xxx.png`，写进 spec：

```json
"background": { "type": "image", "image": "assets/bg-xxx.png" }
```

**注意**：`type=image` 时 `blobs` 仍会叠加，想要纯净背景就去掉 blobs。

### 2. 去背景

用 "Remove Background: Qwen Image 2.1" 模板，或提示词写：

```
This is an RGBA image with transparency. <描述>. The image has alpha channel and the background is transparent.
```

**必须存成 PNG** —— JPG 会丢掉 alpha 通道。

产出放进 `image` 图层：

```json
{ "type": "image", "src": "assets/product-cutout.png",
  "box": { "box": [0.6, 0.5], "size": [0.32, 0.3] }, "fit": "contain" }
```

## 许可证（务必留意）

Qwen-Image-2.1 使用 **Qwen Research License Agreement —— 仅限研究 / 非商业用途**。

- 商用需单独授权：`model-business@notice.qwencloud.com`
- 社区 GGUF / 量化包同属衍生物，受同一许可约束
- **poster-forge 的排版与文字合成不依赖它**，可独立商用

## 未做的事

- 没有自动化的 ComfyUI API 调用脚本（需要用 `/prompt` 端点 + 工作流 JSON）
- 没有把生成结果自动接回 spec 的闭环，目前是手工放文件
