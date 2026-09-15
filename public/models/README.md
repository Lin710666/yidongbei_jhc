# Live2D 模型放这里

这个目录默认是空的。**模型没有随仓库分发，原因是版权。**

脚本会安装的三套形象是 **桃瀬ひより / 春 / Mao**，都来自 Live2D Inc. 的官方示例仓库
[`Live2D/CubismWebSamples`](https://github.com/Live2D/CubismWebSamples)。
Project AIRI 自己也没有把模型提交进仓库，而是在构建时下载；这里沿用同样的做法。

## 怎么拿到

双击仓库根目录的 **`获取示例模型.bat`**，或者：

```powershell
pwsh -File tools\获取示例模型.ps1            # 下载全部 5 个模型（约 33MB）
pwsh -File tools\获取示例模型.ps1 -Skip3D    # 只要 Live2D
pwsh -File tools\获取示例模型.ps1 -Force     # 已装过的也重下
```

下载走 [jsDelivr](https://www.jsdelivr.com/) CDN，不需要账号、不需要梯子。
单个文件失败会自动换镜像重试：`cdn.jsdelivr.net` → `gh-proxy.com` → `raw.githubusercontent.com`。

装完长这样（`manifest.json` 由脚本写，界面上的名字和出处从这里读）：

```
public/models/
├── hiyori/
│   ├── Hiyori.model3.json
│   ├── Hiyori.moc3
│   ├── Hiyori.2048/                ← 纹理
│   ├── motions/                    ← 动作
│   └── manifest.json
├── haru/     （同上结构，动作最多：25 个动作 + 8 个表情）
└── mao/      （同上结构）
```

## 预览图（可选）

形象选择器里每套模型的缩略图是**离线渲染出来的真实一帧**，不是占位图。仓库里没有这些 PNG
（模型本身都不在，带着预览图没意义），选中模型后没有预览图时界面会退化成文字标签，功能不受影响。

想生成预览图，在装好模型之后跑：

```powershell
node test/generate-model-previews.mjs
```

它用真实渲染器（PixiJS + Cubism）逐个渲一帧，存成 `public/models/<id>/preview.png`。
这一步需要开发环境里的 Playwright，普通使用者可以跳过。

## 网络实在不通怎么办

三个镜像都连不上时，脚本会明确告诉你哪几个没装好并以非 0 退出。手动办法：

1. 打开 <https://github.com/Live2D/CubismWebSamples>，点 `Code → Download ZIP`；
2. 解压后把 `Samples/Resources/` 下的 `Hiyori`、`Haru`、`Mao` 三个文件夹
   **整个**复制到本目录，并把文件夹名改成小写（`hiyori` / `haru` / `mao`）；
3. 刷新页面即可。

`manifest.json` 是可选的，不放就用文件夹名当显示名。

## 没有模型会怎样

程序不会崩。舞台会显示一行提示，告诉你去哪拿模型；其余功能（对话、方案、营销、记忆、角色卡、声音）都照常可用。

## 换成自己的模型

把模型文件夹整个放进这个目录即可，要求：

- 目录里有且只有一个 `.model3.json`
- 该 json 指向的 `.moc3` 与纹理文件路径正确（相对路径，别用绝对路径）
- 想要口型同步，`model3.json` 的 `Groups` 里需要有 `LipSync` 组（通常是 `ParamMouthOpenY`）
- 想要动作，需要在 `FileReferences.Motions` 里声明动作组（`Idle`、`TapBody` 等）
- 必须是 **Cubism 4/5** 模型（`moc3`）。Cubism 2 的 `.model.json` 本项目不支持

放好后刷新页面，点舞台右上角的「形象」就能选到。也可以在这个目录里放一个 `manifest.json`：

```json
{ "label": "我的模型", "note": "出处说明", "tags": ["自制"] }
```

## 版权

放进这个目录的模型版权归各自作者所有，本项目不对它们主张任何权利。
Live2D 官方示例模型适用 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html)，
商用前请自己读一遍。需要公开分发时请自行确认授权，尤其注意不要把你从别处下载的、有版权的角色模型提交到公开仓库。
