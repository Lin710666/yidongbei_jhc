# -*- coding: utf-8 -*-
"""
blender-anim.py —— 在 Blender 里建一个会走动的小人，并导出带动画的 glTF
                    （由 lib/blender.js 通过 MCP 的 execute_code 送进 Blender 执行）

为什么要单独一个 .py 而不是把代码塞进 JS 字符串：
   这段是 Blender 的 Python，缩进与引号都很敏感；塞进 JS 模板串里一旦有一处转义
   不对，报错会指向 Blender 内部的 exec，根本看不出是字符串拼接的问题。
   放在独立文件里，语法也能用真正的 Python 检查器验。

调用方式：lib/blender.js 读本文件内容，拼上一句调用，一起发给 execute_code：

    _params = {...}
    <本文件内容>
    _result = _wenlv_build(_params)

## 关于"可循环"

移动动画最容易翻车的地方是**首尾不接**：走一条直线，循环时会有一次瞬移。
所以这里让小人**绕圈巡逻**，并且朝向始终沿切线方向 —— 这样任意时刻首尾都能接上，
看上去就是在景区里不停地走。

## 关于不破坏用户场景

只删除本脚本自己生成的（名字带 `wenlv_` 前缀）对象，并在导出时用
`use_selection=True` 只导出这些对象。**不碰用户已有的任何东西**，
所以在一个已经打开着工程的 Blender 里跑也是安全的（它是幂等的，重复跑不会堆积）。
"""

import math


def _wenlv_build(params):
    import bpy
    import os

    name = params.get('name') or 'walker'
    frames = int(params.get('frames') or 72)
    radius = float(params.get('radius') or 2.4)
    out = params['output']
    stride_cycles = int(params.get('strideCycles') or 4)   # 一圈里迈几步（整数才能无缝循环）
    height = float(params.get('height') or 1.6)

    prefix = 'wenlv_'
    label = prefix + name

    # ---- 幂等：先删掉上次生成的，避免重复运行时对象越堆越多 ----
    for ob in list(bpy.data.objects):
        if ob.name.startswith(prefix):
            bpy.data.objects.remove(ob, do_unlink=True)
    for block in list(bpy.data.meshes):
        if block.name.startswith(prefix) and block.users == 0:
            bpy.data.meshes.remove(block)

    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = frames

    # ---- 材质 ----
    def mat(mname, rgb, rough=0.6, metal=0.0):
        m = bpy.data.materials.get(prefix + mname) or bpy.data.materials.new(prefix + mname)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
            if 'Roughness' in bsdf.inputs:
                bsdf.inputs['Roughness'].default_value = rough
            if 'Metallic' in bsdf.inputs:
                bsdf.inputs['Metallic'].default_value = metal
        return m

    m_body = mat('body', (0.16, 0.47, 0.72))
    m_head = mat('head', (0.96, 0.80, 0.62))
    m_limb = mat('limb', (0.24, 0.26, 0.30))

    created = []

    def add(kind, oname, loc, scale, material, rot=(0, 0, 0)):
        if kind == 'sphere':
            bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=0.5, location=loc)
        elif kind == 'cyl':
            bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.5, depth=1.0, location=loc)
        else:
            bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
        ob = bpy.context.active_object
        ob.name = prefix + oname
        ob.scale = scale
        ob.rotation_euler = rot
        ob.data.materials.append(material)
        created.append(ob)
        return ob

    # ---- 身体各部件（先按"身高 1.6m"的比例摆好，单位是米）----
    s = height / 1.6
    torso = add('cyl', 'torso', (0, 0, 1.06 * s), (0.32 * s, 0.32 * s, 0.52 * s), m_body)
    head = add('sphere', 'head', (0, 0, 1.50 * s), (0.42 * s, 0.42 * s, 0.42 * s), m_head)
    arm_l = add('cyl', 'arm_l', (0.24 * s, 0, 1.06 * s), (0.09 * s, 0.09 * s, 0.44 * s), m_limb)
    arm_r = add('cyl', 'arm_r', (-0.24 * s, 0, 1.06 * s), (0.09 * s, 0.09 * s, 0.44 * s), m_limb)
    leg_l = add('cyl', 'leg_l', (0.12 * s, 0, 0.40 * s), (0.10 * s, 0.10 * s, 0.52 * s), m_limb)
    leg_r = add('cyl', 'leg_r', (-0.12 * s, 0, 0.40 * s), (0.10 * s, 0.10 * s, 0.52 * s), m_limb)

    # ---- 用一个空物体当"根"，移动与转向都加在它身上 ----
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = prefix + 'root'
    created.append(root)

    for ob in (torso, head, arm_l, arm_r, leg_l, leg_r):
        ob.parent = root
        # 保留世界变换：parent 之后再修正局部坐标，否则部件会跟着根一起被挪走
        ob.matrix_parent_inverse = root.matrix_world.inverted()

    # ---- 关键帧：绕圈巡逻 + 四肢摆动 + 上下起伏 ----
    #
    # 角速度：一整圈走完 frames 帧，所以每帧 dθ = 2π/(frames-1)。
    # 迈步周期用 stride_cycles 控制，取整数才能让"摆动"在首尾对齐
    # （非整数的话循环接缝处手脚会突然反向，一眼就能看出来）。
    #
    # 采样点要**包含 t=0 与 t=1 两端**：t=0 与 t=1 的位置/朝向完全相同，
    # 这样 glTF 播放到结尾接回开头时不会有"跳一下"。
    # 第一版写成 range(1, frames+1, step)，最后一帧只到 t=0.972，循环就是断的。
    TWO_PI = math.pi * 2.0
    step = 2                                        # 每 2 帧一个关键帧
    key_frames = list(range(1, frames, step))
    if key_frames[-1] != frames:
        key_frames.append(frames)                   # 保证最后一帧正好落在 t=1
    for f in key_frames:
        t = (f - 1) / float(frames - 1)             # 0..1（含端点）
        theta = TWO_PI * t                          # 绕圈进度
        swing = math.sin(TWO_PI * stride_cycles * t)  # -1..1 的迈步相位

        root.location = (radius * math.cos(theta), radius * math.sin(theta), 0.0)
        # 朝向切线方向：切线是 (-sinθ, cosθ)，而物体默认朝 +Y，所以转到 θ+90°
        root.rotation_euler = (0.0, 0.0, theta + math.pi / 2.0)
        root.keyframe_insert(data_path='location', frame=f)
        root.keyframe_insert(data_path='rotation_euler', frame=f)

        # 上下起伏：一个迈步周期起伏两次（左右脚各一次）
        bob = abs(math.sin(TWO_PI * stride_cycles * t)) * 0.055 * s
        torso.location = (0, 0, 1.06 * s + bob)
        head.location = (0, 0, 1.50 * s + bob)
        torso.keyframe_insert(data_path='location', frame=f)
        head.keyframe_insert(data_path='location', frame=f)

        # 四肢前后摆：左右反相
        arm_l.rotation_euler = (swing * 0.55, 0.0, 0.0)
        arm_r.rotation_euler = (-swing * 0.55, 0.0, 0.0)
        leg_l.rotation_euler = (-swing * 0.62, 0.0, 0.0)
        leg_r.rotation_euler = (swing * 0.62, 0.0, 0.0)
        for ob in (arm_l, arm_r, leg_l, leg_r):
            ob.keyframe_insert(data_path='rotation_euler', frame=f)

    # ---- 导出：只导出自己生成的对象 ----
    bpy.ops.object.select_all(action='DESELECT')
    for ob in created:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = root

    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)

    kwargs = dict(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_yup=True,            # 直接导成 Y 轴朝上，省得网页端再转一次
        export_apply=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # 不同 Blender 版本的导出参数名有出入，退到最小可用集合再试一次
        bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)

    size = os.path.getsize(out) if os.path.exists(out) else 0
    return {
        'ok': bool(size),
        'output': out,
        'bytes': size,
        'objects': [ob.name for ob in created],
        'frames': frames,
        'fps': scene.render.fps,
        'durationSeconds': round(frames / float(scene.render.fps), 3),
        'radius': radius,
        'blenderVersion': bpy.app.version_string,
    }
