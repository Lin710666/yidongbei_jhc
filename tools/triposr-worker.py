#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
triposr-worker.py —— 单图生成三维网格（TripoSR），被 lib/img23d.js 以子进程调用

输入一张图片，输出一个带顶点色的 GLB 网格。生成的模型会登记进项目已有的
3D 舞台，所以"图片转 3D"的产物能直接被角色形象选择器加载。

## 为什么要装一个 torchmcubes 垫片

TripoSR 用 `torchmcubes` 做等值面提取，而它**只有源码、没有 Windows 预编译包**
（`pip install torchmcubes` 直接报 No matching distribution），自己编译要 MSVC 工具链。
好在等值面提取本身是标准算法，`PyMCubes`（`mcubes`）有现成 wheel。

所以这里不去改 TripoSR 的源码（vendored 第三方代码改了就说不清是谁的 bug），
而是在 import `tsr` **之前**往 `sys.modules` 里塞一个同名的假模块把接口接上。
补丁在此一处、显式可见，升级 TripoSR 时也只需重看这里。

## 关于显存

TripoSR 是 transformer + NeRF 渲染，256³ 的等值面网格在 8GB 卡上比较紧。
本机 RTX 5060 实测可用；若爆显存，调小 --resolution（如 192）或 --chunk-size。
"""

import argparse
import json
import os
import sys
import time

# 关于显存碎片：CUDA OOM 的提示里常建议设 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True。
# 但**不要在这里默认打开** —— 实测本机 torch 2.11+cu128 + RTX 5060 驱动上，
# 打开之后会改成抛 `CUDA error: shared object initialization failed`，
# 那是个更难查的错。所以保持默认，需要时由使用者自己设环境变量：
#     set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
# 更稳的省显存办法是调小 --resolution 与 --chunk-size。


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fail(code, msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def install_mcubes_shim():
    """把 torchmcubes 换成基于 PyMCubes 的实现（接口一致：体积 + 阈值 → 顶点/三角面）"""
    try:
        import torchmcubes  # noqa: F401
        log('[triposr] 本机已有 torchmcubes，直接用')
        return 'torchmcubes'
    except Exception:
        pass

    try:
        import mcubes
        import numpy as np
        import torch
    except Exception as e:  # noqa: BLE001
        fail(2, f'等值面提取既没有 torchmcubes 也没有 mcubes：{e}\n'
                f'在项目 venv 里执行：python -m pip install PyMCubes')

    # 这里有个坑：PyPI 上同时存在 `mcubes` 与 `PyMCubes` 两个包，**是不同的库**。
    # `mcubes` 导出 MarchingCubes/Mesh，没有 marching_cubes 函数；
    # 我们要的是 `PyMCubes`。装错了会一路跑到提取网格时才炸，报错还指向别处。
    if not hasattr(mcubes, 'marching_cubes'):
        got = [n for n in dir(mcubes) if not n.startswith('_')][:8]
        fail(2, '装错了包：当前 mcubes 里没有 marching_cubes 函数。\n'
                f'  当前位置：{getattr(mcubes, "__file__", "?")}\n'
                f'  它导出的名字：{got}\n'
                'PyPI 上 `mcubes` 与 `PyMCubes` 是两个不同的库，本功能需要后者。\n'
                '请执行：python -m pip uninstall -y mcubes && python -m pip install PyMCubes')

    import types
    mod = types.ModuleType('torchmcubes')

    def marching_cubes(volume, threshold):
        # PyMCubes 要 numpy 的连续 float32 数组；返回的是 numpy 数组，转回 torch
        arr = np.ascontiguousarray(volume.detach().cpu().numpy(), dtype=np.float32)
        verts, faces = mcubes.marching_cubes(arr, float(threshold))
        v = torch.from_numpy(verts).float()
        # !!! 这里必须把轴序倒过来，否则模型会悄悄转 90° !!!
        #
        # 演进过程：PyMCubes 返回的顶点坐标就是数组下标 (d0,d1,d2)；
        # 而 TripoSR 的 tsr/models/isosurface.py 里有一句
        #     v_pos = v_pos[..., [2, 1, 0]]
        # 那是为 torchmcubes 的返回约定做的补偿（torchmcubes 给的是反序）。
        # 我们把 torchmcubes 换掉之后，那句补偿仍然会执行，于是变成"换两次" ——
        # 结果模型没错，但整体被转置了，看上去只是"朝向有点怪"。
        #
        # 用一个已知位置的体素验证过（目标中心 x=0.20 z=0.80）：
        #   不预交换 → 得到 x=0.801 z=0.199（轴序错位）
        #   预交换   → 得到 x=0.199 z=0.801（正确）
        v = v[:, [2, 1, 0]]
        return v, torch.from_numpy(faces).long()

    mod.marching_cubes = marching_cubes
    sys.modules['torchmcubes'] = mod
    return 'mcubes-shim'


def install_bake_device_fix():
    """
    修 TripoSR 的一个设备不匹配 bug（只在需要烘焙贴图时调用）。

    官方实现 tsr/bake_texture.py 的 positions_to_colors 里：

        positions = torch.tensor(positions_texture.reshape(-1, 4)[:, :-1])

    这个张量建在 **CPU** 上，而 scene_code（以及模型）在 CUDA 上，
    于是走到 query_triplane 内部的 grid_sample 就报：

        RuntimeError: Expected all tensors to be on the same device,
        but got grid is on cpu, different from other tensors on cuda:0

    也就是说 **GPU 上烘焙贴图这条路在官方代码里本来就是坏的**（CPU 上跑才没事）。

    处理方式与 torchmcubes 垫片一致：不改 vendored 源码，在这里把那个函数替换成
    逐行相同、只多一个 device 参数版本。用 .cpu() 兜住 .numpy()，
    免得 color 张量在 GPU 上时又炸在转换那一步。
    """
    import numpy as np
    import torch
    import tsr.bake_texture as bt

    def positions_to_colors_fixed(model, scene_code, positions_texture, texture_resolution):
        arr = positions_texture.reshape(-1, 4)[:, :-1]
        positions = torch.tensor(arr, device=scene_code.device, dtype=torch.float32)
        with torch.no_grad():
            queried_grid = model.renderer.query_triplane(model.decoder, positions, scene_code)
        rgb_f = queried_grid['color'].detach().cpu().numpy().reshape(-1, 3)
        rgba_f = np.insert(rgb_f, 3, positions_texture.reshape(-1, 4)[:, -1], axis=1)
        rgba_f[rgba_f[:, -1] == 0.0] = [0, 0, 0, 0]
        return rgba_f.reshape(texture_resolution, texture_resolution, 4)

    bt.positions_to_colors = positions_to_colors_fixed
    log('[triposr] 已修补 bake_texture 的设备不匹配问题（positions 跟随 scene_code 所在设备）')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='TripoSR 模型目录（含 config.yaml 与 model.ckpt）')
    ap.add_argument('--code', required=True, help='TripoSR 源码目录（含 tsr/ 包）')
    ap.add_argument('--input', required=True, help='输入图片路径')
    ap.add_argument('--output', required=True, help='输出 GLB 路径')
    # 默认 160/2048 是"显卡上还有别的程序在跑"时的稳当档位。
    # 实测本机（ComfyUI + 本地大模型占着约 4.6GB 显存）时：
    #   192/4096 → CUDA error: unknown error
    #   160/2048 → 成功，14758 顶点 / 29512 面 / 约 2 分钟
    # 显卡空着时可以调到 256 拿更细的网格。
    ap.add_argument('--resolution', type=int, default=160, help='等值面网格分辨率（显存不够就调小到 128）')
    ap.add_argument('--chunk-size', type=int, default=2048, help='NeRF 渲染分块，越小越省显存')
    ap.add_argument('--no-remove-bg', action='store_true', help='不去背景（要求输入已是灰底主体图）')
    ap.add_argument('--rembg-model', default='', help='rembg 用哪个分割模型（默认 u2net；内存紧张可试 u2netp）')
    ap.add_argument('--bake-texture', action='store_true', help='烘焙贴图集（更费时，但贴图比顶点色精细）')
    ap.add_argument('--texture-resolution', type=int, default=1024, help='贴图集分辨率')
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        fail(2, f'模型目录不存在：{args.model}\n请先运行 npm run fetch:triposr（约 1.6GB）')
    if not os.path.isfile(os.path.join(args.model, 'model.ckpt')):
        fail(2, f'模型目录里没有 model.ckpt：{args.model}\n下载可能中断了，重新运行 npm run fetch:triposr')
    if not os.path.isdir(os.path.join(args.code, 'tsr')):
        fail(2, f'找不到 TripoSR 源码（{args.code}/tsr）。')
    if not os.path.isfile(args.input):
        fail(3, f'输入图片不存在：{args.input}')

    t0 = time.time()
    shim = install_mcubes_shim()
    log(f'[triposr] 等值面提取后端：{shim}')

    # 让 tsr 能 import 到；必须放在垫片之后（保证它 import torchmcubes 时拿到我们的实现），
    # 也必须放在下面的补丁之前（补丁自己就要 import tsr.bake_texture —— 这里踩过一次：
    # 顺序反了会得到 ModuleNotFoundError: No module named 'tsr'，而错误被兜住之后
    # 表现成"烘焙悄悄退回顶点色"，很难看出是路径问题）。
    sys.path.insert(0, os.path.abspath(args.code))

    if args.bake_texture:
        try:
            install_bake_device_fix()
        except Exception as e:  # noqa: BLE001
            # 补丁失败不该让整个任务失败 —— 后面烘焙会自己失败并退到顶点色
            log(f'[triposr] 贴图烘焙补丁安装失败（将退到顶点色）：{type(e).__name__}: {e}')

    # 让 tsr 能 import 到；已经在上面插入过了，这里不再重复
    try:
        import numpy as np
        import torch
        import trimesh
        from PIL import Image
        from tsr.system import TSR
        from tsr.utils import remove_background, resize_foreground
        from tsr.bake_texture import bake_texture
    except Exception as e:  # noqa: BLE001
        fail(2, f'导入 TripoSR 依赖失败：{type(e).__name__}: {e}\n'
                f'请在项目 venv 里补齐依赖（trimesh / omegaconf / plyfile / xatlas / opencv / timm / mcubes / rembg）')

    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    log(f'[triposr] 设备：{device}')

    try:
        t1 = time.time()
        model = TSR.from_pretrained(args.model, config_name='config.yaml', weight_name='model.ckpt')
        model.renderer.set_chunk_size(args.chunk_size)
        model.to(device)
        log(f'[triposr] 模型载入 {time.time()-t1:.1f}s')

        t2 = time.time()
        img = Image.open(args.input)
        remove_bg_failed = None
        if args.no_remove_bg:
            image = np.array(img.convert('RGB'))
        else:
            # 去背景是**增强项**，不是必需项：它挂了也应该继续出模型，只是效果差些。
            # 实测本机（15.8GB 内存 / 8GB 显存，同时跑着 ComfyUI 与本地大模型时）
            # onnxruntime 会因内存不足直接抛 ONNXRuntimeError: BFCArena AllocateRawInternal。
            # 那种情况下让整个任务失败是最糟的选择 —— 用户明明可以拿到一个稍差的模型。
            try:
                import rembg
                # 注意：不能写成 new_session(args.rembg_model or None) ——
                # 这个版本的 rembg 会把显式的 None 当成模型名 "None" 去查，
                # 报 "No session class found for model 'None'"。
                # 要默认模型就**不传参数**。
                session = rembg.new_session(args.rembg_model) if args.rembg_model else rembg.new_session()
                image = remove_background(img, session)
                image = resize_foreground(image, 0.85)
                image = np.array(image).astype(np.float32) / 255.0
                # 把透明背景合成为中灰：TripoSR 训练时用的就是灰底，直接喂 RGBA 效果会差
                image = image[:, :, :3] * image[:, :, 3:4] + (1 - image[:, :, 3:4]) * 0.5
                image = Image.fromarray((image * 255.0).astype(np.uint8))
            except Exception as e:  # noqa: BLE001
                remove_bg_failed = f'{type(e).__name__}: {str(e).splitlines()[0][:200]}'
                log(f'[triposr] 去背景失败，改用原图直接推理（结果可能含背景）：{remove_bg_failed}')
                image = np.array(img.convert('RGB'))
        log(f'[triposr] 图像预处理 {time.time()-t2:.1f}s')

        t3 = time.time()
        with torch.no_grad():
            scene_codes = model([image], device=device)
        if device.startswith('cuda'):
            torch.cuda.synchronize()
        log(f'[triposr] 推理 {time.time()-t3:.1f}s')

        t4 = time.time()
        meshes = model.extract_mesh(scene_codes, not args.bake_texture, resolution=args.resolution)
        log(f'[triposr] 网格提取 {time.time()-t4:.1f}s  顶点 {len(meshes[0].vertices)}  面 {len(meshes[0].faces)}')

        # ---- 坐标系转换：TripoSR 的 (x=back, y=right, z=up) → three.js 的 (X=右, Y=上, Z=前) ----
        #
        # 出处：tsr/utils.py 里 get_spherical_cameras 的注释
        #   "right hand coordinate system, x back, y right, z up"
        # 而 three.js / VRM（本项目的 3D 舞台）是 X 右、Y 上、Z 朝观察者。
        #
        # 所以要的是**循环置换** (x,y,z) → (y,z,x)：
        #   屏幕左右(原 y) → X ；屏幕上下(原 z) → Y ；景深(原 x) → Z
        # 这个置换的行列式是 +1，属于真旋转（绕 (1,1,1) 转 120°），
        # 所以不会把模型镜像掉 —— 用镜像矩阵会得到"反过来的"模型，很难察觉。
        #
        # 怎么确认的：拿输入图的长宽比当标尺。原图 410×310 = 1.323；
        # 未经转换时三轴跨度是 x=0.299 y=1.058 z=0.800，其中 y/z = 1.32 完全吻合 ——
        # 说明原 y 就是屏幕左右轴、原 z 是上下轴。按这个置换之后
        # X/Y = 1.058/0.800 = 1.32，对上了。
        #
        # 注意：第一版我写的是"绕 X 转 -90°"，那是错的 —— 它只是把 z 抬成 Y，
        # 却把"左右"轴丢到了 Z 上，模型进舞台会变成又窄又深的一条。
        import numpy as np
        import trimesh
        perm = np.array([
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [1, 0, 0, 0],
            [0, 0, 0, 1],
        ], dtype=float)
        meshes[0].apply_transform(perm)
        meshes[0].apply_translation(-meshes[0].bounds.mean(axis=0))
        log(f'[triposr] 已转为 Y 轴朝上并居中，包围盒 {np.round(meshes[0].bounds, 3).tolist()}')

        os.makedirs(os.path.dirname(os.path.abspath(args.output)) or '.', exist_ok=True)
        textured = False

        if args.bake_texture:
            try:
                t5 = time.time()
                baked = bake_texture(meshes[0], model, scene_codes[0], args.texture_resolution)
                tex_img = Image.fromarray((baked['colors'] * 255.0).astype(np.uint8)).transpose(Image.FLIP_TOP_BOTTOM)

                # 关键：**不能**用 xatlas.export 直接写 .glb —— 它只写 OBJ 文本。
                # 之前就是这里出的问题：文件扩展名是 .glb，内容却是 OBJ（文件头是 "v ..."），
                # 而项目的模型库会校验 glTF 魔数，于是"烘焙成功却登记不进去"。
                # 改用 trimesh 建一个带贴图的网格再导出，贴图会被内嵌进 GLB。
                vis = trimesh.visual.TextureVisuals(
                    uv=baked['uvs'],
                    material=trimesh.visual.material.PBRMaterial(
                        baseColorTexture=tex_img, metallicFactor=0.0, roughnessFactor=0.8,
                    ),
                )
                tex_mesh = trimesh.Trimesh(
                    vertices=meshes[0].vertices[baked['vmapping']],
                    faces=baked['indices'],
                    visual=vis,
                    process=False,
                )
                # meshes[0] 已经在上面做过坐标置换与居中，vmapping 索引的就是它，
                # 所以这里不需要再转一次
                tex_mesh.export(args.output)
                log(f'[triposr] 贴图烘焙 {time.time()-t5:.1f}s -> {args.output}（贴图已内嵌）')
                textured = True
            except Exception as e:  # noqa: BLE001
                # 烘焙失败不该让整件事失败：退到顶点色，并如实说明
                log(f'[triposr] 贴图烘焙失败，改用顶点色：{type(e).__name__}: {e}')
                # 注意：按"要烘焙"取出来的网格是 has_vertex_color=False 的，**它本身没有颜色**。
                # 直接导出会得到一个灰模。所以这里重新取一次带顶点色的网格。
                colored = model.extract_mesh(scene_codes, True, resolution=args.resolution)
                colored[0].apply_transform(perm)
                colored[0].apply_translation(-colored[0].bounds.mean(axis=0))
                colored[0].export(args.output)
        else:
            meshes[0].export(args.output)

        size = os.path.getsize(args.output)
        bbox = meshes[0].bounds.tolist() if hasattr(meshes[0], 'bounds') else None
        print(json.dumps({
            'ok': True,
            'output': args.output,
            'bytes': size,
            'vertices': int(len(meshes[0].vertices)),
            'faces': int(len(meshes[0].faces)),
            'resolution': args.resolution,
            'textured': textured,
            'device': device,
            'shim': shim,
            'bounds': bbox,
            'removeBgFailed': remove_bg_failed,
            'seconds': round(time.time() - t0, 2),
        }, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        import traceback
        log(traceback.format_exc())
        msg = str(e)
        # 爆显存是最常见的失败，单独给一条能照做的提示
        if 'out of memory' in msg.lower():
            fail(4, '显存不足。\n'
                    f'  当前分辨率 {args.resolution}、分块 {args.chunk_size}。\n'
                    '  可以照做：\n'
                    '   · 调小分辨率与分块：--resolution 160 --chunk-size 2048（再不行 128 / 1024）\n'
                    '   · 关掉正在占用显卡的程序（ComfyUI / 本地大模型 / 游戏 / 浏览器硬件加速）\n'
                    f'  原始错误：{msg}')
        fail(1, f'图生 3D 失败：{msg}')


if __name__ == '__main__':
    main()
