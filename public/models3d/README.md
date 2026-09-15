# 3D 模型放这里

这个目录默认是空的。脚本会安装的两套 3D 形象来自 VRM 官方规范仓库
[`vrm-c/vrm-specification`](https://github.com/vrm-c/vrm-specification)，同样属于第三方素材，
和 Live2D 模型一样没有随仓库分发。

## 怎么拿到

双击仓库根目录的 **`获取示例模型.bat`**，或者：

```powershell
pwsh -File tools\获取示例模型.ps1 -SkipLive2D   # 只要 3D
```

脚本会下载两个 `.vrm`（约 22MB）到：

```
public/models3d/
├── seed-san/
│   ├── Seed-san.vrm                ← VRM 官方示例角色，可跟随视线 / 眨眼
│   └── manifest.json
└── vrm1-sample/
    ├── VRM1_Constraint_Twist_Sample.vrm
    └── manifest.json
```

`manifest.json` 是可选的，用来给界面提供显示名与说明：

```json
{ "label": "我的模型", "note": "出处", "tags": ["自制"], "kind": "3d" }
```

## 换成自己的模型

有两种方式：

1. **界面上传（推荐）**：点舞台右上角「形象」→「上传 VRM / GLB」，选一个 `.vrm` 或 `.glb`。
   文件会存到本机 `data/models3d/`，不进仓库，也不会被 `git` 跟踪。
   上传后程序会自动给模型截一张预览图。
2. **放进这个目录**：`public/models3d/<名字>/<文件>.vrm`，再补一个 `manifest.json`。

## 支持哪些格式

| 扩展名 | 说明 |
| --- | --- |
| `.vrm` | VRoid / VRM 虚拟形象。带标准化骨骼与表情，所以能跟随视线、眨眼、说话时动嘴 |
| `.glb` | glTF 二进制单文件。没有骨骼的话只能整体显示与待机摆动 |

**不支持 `.gltf`**（文本格式通常还要带一堆散装 `.bin` 与贴图，网页上「传一个文件」带不全）。
如果你手上是 `.gltf`，导出时选 `.glb`。

上传时会检查文件头是不是 `glTF` 魔数，改名伪装的文件会被拒绝。单个文件上限 100MB。

## 版权

同上。放进这个目录的模型版权归各自作者所有，公开分发前请确认授权。
