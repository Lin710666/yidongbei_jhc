/**
 * stage3d.js —— 3D 角色舞台（three.js + @pixiv/three-vrm）
 *
 * 这个文件是 **ES Module**，而且是被 app.js 用 `await import()` 按需加载的。
 * 原因：three.js 1.3MB + three-vrm 0.9MB 加起来 2.2MB，
 * 而默认形象是 Live2D —— 不能为了"支持 3D"就让所有用户都先下这 2.2MB。
 * 只有真的选了 3D 形象，才会加载它。
 *
 * 依赖用 importmap 映射（见 index.html）：
 *   "three"          -> /vendor/three/three.module.js
 *   "three/addons/"  -> /vendor/three/addons/
 *
 * 支持格式：.vrm（VRM 0.x / 1.0）、.glb、.gltf
 *
 * 实现的互动（VRM 有骨骼与表情才能做，纯 glb 只能做整体位移）：
 *   · 视线跟随鼠标（vrm.lookAt）
 *   · 自动眨眼（程序化驱动 blink 表情）
 *   · 说话口型（用 TTS 音频的实时频谱驱动 aa 表情）
 *   · 待机呼吸与轻微摆动（程序化，不依赖外部动画文件）
 *   · 点头/摇头等小动作（点一下触发）
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
// three-vrm 用相对路径引，少一条 importmap 映射就少一个出错的地方；
// 它内部只 import 'three'，那条由 importmap 负责。
import { VRMLoaderPlugin, VRMUtils } from '../vendor/three/three-vrm.module.js'
import { PanoramaScene } from './pano.js'

/** 目标身高（米）。VRM 本身按米建模，纯 glb 可能是任意尺度，统一归一到这个高度 */
const TARGET_HEIGHT = 1.62

export class ThreeDStage {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    this.scene = null
    this.camera = null
    this.model = null
    this.vrm = null
    this.mixer = null
    this.clock = new THREE.Clock()
    this.ready = false
    this.url = null

    // 交互状态
    this.pointer = { x: 0, y: 0 }          // -1..1，鼠标在舞台里的归一化位置
    this.lookTarget = null
    this.mouthOpen = 0
    this.targetMouthOpen = 0
    this.analyser = null
    this.audioCtx = null
    this.audioSource = null
    // 文本驱动口型（没有音频可放时用；见 update 里的分支与 talkTo）
    this.talking = false
    this.talkText = ''
    this.talkIndex = 0
    this.talkAcc = 0
    this.lastTick = 0

    // 程序化待机
    this.idlePhase = Math.random() * Math.PI * 2
    this.blinkTimer = 1.5
    this.blinkPhase = -1                    // <0 表示没在眨
    this.nodUntil = 0
    // 待机总开关（与 Live2D 那套 startIdle/stopIdle 语义一致）
    this.idleOn = true
    this.idleWanted = true
    this._nextIdleMotionAt = 0
    this._idleMotionEvery = 14000
    // 导航模式：手里的牌子 + 身后的风景
    this.placard = null
    this._placardMesh = null
    this._sceneryTex = null
    this.lastPointerAt = 0

    // 用户可调（与 Live2D 那套保持一致的语义）
    this.userScale = 1
    this.userX = 0
    this.userY = 0
    this.baseScale = 1
    this.modelBaseY = 0
    this.targetHeight = TARGET_HEIGHT

    this.onReadyCb = null
    this.onTapCb = null
    this.geoMarker = null                   // 地理标记（指北环 + 方位箭头）
    // 场景模式：'character' 看人物；'panorama' 站在景区全景里环视
    this.mode = 'character'
    this.pano = null                        // PanoramaScene（用到才建）
    this._panoAdded = false
    this._raf = null
    this._disposed = false
  }

  /** three.js 是否已经加载好可用（app.js 用它决定要不要懒加载） */
  static async available() {
    try {
      await import('three')
      return true
    } catch {
      return false
    }
  }

  async init() {
    if (this.renderer) return

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,                 // 透明底：后面的背景层能透出来
      antialias: true,
      preserveDrawingBuffer: true, // 便于验收脚本采样像素
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()

    // 光照：半球光给环境色，主光从斜前上方打，补光压一下阴影面
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8b93a7, 2.0)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0.6, 1.6, 1.2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xa9c6ff, 0.6)
    fill.position.set(-0.9, 0.9, 0.8)
    this.scene.add(fill)

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)

    // 视线目标：一个空对象，鼠标一动就把它挪到对应的方位
    this.lookTarget = new THREE.Object3D()
    this.lookTarget.position.set(0, 1.4, 2)
    this.scene.add(this.lookTarget)

    const host = this.canvas.parentElement
    host.addEventListener('mousemove', (e) => {
      const r = host.getBoundingClientRect()
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
      this.pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1
      this.markPointer()
    })
    host.addEventListener('mouseleave', () => { this.pointer.x = 0; this.pointer.y = 0 })
    host.addEventListener('pointerdown', (e) => {
      // 全景模式下按下是"开始拖动视角"，不该顺手触发角色的小动作
      if (this.mode === 'panorama') {
        this._drag = { x: e.clientX, y: e.clientY }
        try { host.setPointerCapture(e.pointerId) } catch { /* 某些浏览器不支持，忽略 */ }
        return
      }
      if (this.onTapCb) this.onTapCb()
    })
    host.addEventListener('pointermove', (e) => {
      if (this.mode !== 'panorama' || !this._drag || !this.pano) return
      const dx = e.clientX - this._drag.x
      const dy = e.clientY - this._drag.y
      this._drag.x = e.clientX
      this._drag.y = e.clientY
      // 0.18 度/像素：转过 360° 需要约 2000px，正好是"拖动两三屏"的手感
      this.pano.setView(this.pano.yaw + dx * 0.18, this.pano.pitch - dy * 0.18)
    })
    const endDrag = () => { this._drag = null }
    host.addEventListener('pointerup', endDrag)
    host.addEventListener('pointercancel', endDrag)
    host.addEventListener('pointerleave', endDrag)

    // 尺寸变化就重新摆相机。和 Live2D 那边一样，光靠 window.resize 不够：
    // 舞台尺寸还会因为侧栏、全屏词云、字体加载等原因变，那些不一定触发 window 的 resize。
    window.addEventListener('resize', () => this.scheduleResize())
    if (typeof window.ResizeObserver === 'function') {
      this.ro = new window.ResizeObserver(() => this.scheduleResize())
      this.ro.observe(host)
    }
    this.lastDpr = Math.min(window.devicePixelRatio || 1, 2)
    this.ready = true
    this._loop()
  }

  /** 一帧内触发多次也只重排一次 */
  scheduleResize() {
    if (this.resizeRaf) return
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0
      this.resize()
    })
  }

  /**
   * 载入模型。
   * @param {string} url .vrm / .glb / .gltf 地址
   */
  async load(url) {
    if (!this.renderer) await this.init()
    this.url = url
    if (this.model) this._unload()

    const loader = new GLTFLoader()
    // 注册 VRM 插件：不是 VRM 的文件它不会插手，所以一个 loader 通吃 .vrm/.glb
    loader.register(parser => new VRMLoaderPlugin(parser))

    let gltf
    try {
      gltf = await loader.loadAsync(url)
    } catch (e) {
      throw new Error(`3D 模型加载失败：${e && e.message ? e.message : e}\n模型地址：${url}`)
    }

    const vrm = gltf.userData.vrm
    this.vrm = vrm || null
    const model = vrm ? vrm.scene : gltf.scene
    if (!model) throw new Error('文件里没有可显示的 3D 场景')

    // VRM 0.x 是朝 +Z 的（面对镜头背面），统一转成朝 -Z，和 glTF 约定一致
    if (vrm) {
      try { VRMUtils.rotateVRM0(vrm) } catch { /* 旧版本没有这个工具，忽略 */ }
    }
    model.traverse((obj) => {
      obj.frustumCulled = false          // 骨骼动画容易算出错误的包围盒，直接关掉
      if (obj.isMesh) obj.castShadow = false
    })

    this.model = model
    this.scene.add(model)

    // glTF 自带动画（例如 Blender 导出的行走动画）：建一个 mixer 循环播放。
    // 之前 this.mixer 只声明了没用过 —— 也就是"能加载 GLB，但里面的动画是静止的"。
    // 这类问题在界面上表现为"模型不动"，很容易被当成"没做动画"。
    this.animations = (gltf.animations || []).map(c => ({ name: c.name, duration: c.duration }))
    // 自己维护 name → action 的映射：three.js 的 mixer._actions 是私有字段，
    // 直接读它在版本升级时可能突然坏掉，而且坏了不报错、只是动作播不出来。
    this._actionsByName = new Map()
    if (gltf.animations && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model)
      for (const clip of gltf.animations) {
        try {
          const action = this.mixer.clipAction(clip)
          action.setLoop(THREE.LoopRepeat, Infinity)
          action.clampWhenFinished = false
          action.play()
          this._actionsByName.set(clip.name, action)
        } catch { /* 单个轨道坏掉不该让整只模型加载失败 */ }
      }
    }

    // 归一化尺度与落地点：算包围盒 -> 缩到目标身高 -> 脚底贴地 -> 水平居中
    const box = new THREE.Box3().setFromObject(model)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const h = size.y || 1
    this.baseScale = TARGET_HEIGHT / h
    this.modelBaseY = -box.min.y * this.baseScale
    model.scale.setScalar(this.baseScale)
    model.position.set(-center.x * this.baseScale, this.modelBaseY, -center.z * this.baseScale)

    // VRM：把 T-pose 掰成自然站姿（见方法注释），再接上视线跟随
    if (vrm) {
      this._applyRelaxedPose(vrm)
      if (vrm.lookAt) {
        try {
          vrm.lookAt.target = this.lookTarget
          // 有些 VRM 0.x 的 lookAt 需要显式指定朝向
          if (typeof vrm.lookAt.autoUpdate === 'boolean') vrm.lookAt.autoUpdate = true
        } catch { /* 忽略 */ }
      }
    }

    this.applyTransform()
    this.resize()
    if (this.onReadyCb) {
      this.onReadyCb({
        url,
        isVRM: Boolean(vrm),
        hasExpressions: Boolean(vrm && vrm.expressionManager),
        expressionNames: vrm && vrm.expressionManager
          ? Object.keys(vrm.expressionManager.expressionMap || {})
          : [],
        // 让界面知道"这个模型带几段动画" —— 否则用户看不出动画到底有没有被加载
        animations: this.animations || [],
      })
    }
    return model
  }

  /**
   * 把 VRM 的 T-pose 掰成自然站姿。
   *
   * 为什么必须做：VRM 文件的"静止姿态"就是双臂平举的 T-pose（建模约定），
   * 不加载任何动画时人物会一直张开双臂站着，看起来像没做完。
   * three-vrm 的 normalized bone 提供一个与原始骨骼解耦的标准化骨架，
   * 直接旋转上臂就能把手臂放下来，不需要 MMA/动画文件。
   *
   * 角度是试出来的：上臂绕 Z 轴约 79° 让手臂自然下垂并略微外张（A-pose）。
   * 只动上臂，**不动小臂与手腕** —— 试过给 lowerArm 加内旋、给 hand 加偏转，
   * 结果手部朝向反而变得别扭（不同模型的骨骼朝向约定并不统一，
   * 猜错轴就会把手拧到背后）。只放上臂是"对任何模型都不会更丑"的最小改动。
   */
  _applyRelaxedPose(vrm) {
    if (!vrm.humanoid) return
    try {
      const set = (name, axis, value) => {
        const b = vrm.humanoid.getNormalizedBoneNode(name)
        if (b) b.rotation[axis] = value
      }
      set('leftUpperArm', 'z', Math.PI * 0.44)
      set('rightUpperArm', 'z', -Math.PI * 0.44)
      this._relaxedPoseApplied = true
    } catch { /* 骨骼名不在的模型就直接保持原样 */ }
  }

  _unload() {
    if (!this.model) return
    // mixer 要显式停掉并断开：不清的话切模型后旧动画还在按帧驱动已释放的骨骼，
    // 表现是切完模型控制台报错、或者新模型诡异地抖。
    if (this.mixer) {
      try { this.mixer.stopAllAction() } catch { /* 忽略 */ }
      try { this.mixer.uncacheRoot(this.model) } catch { /* 忽略 */ }
      this.mixer = null
    }
    this.animations = []
    this.scene.remove(this.model)
    this.model.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : [])
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k]
          if (v && v.isTexture) v.dispose()
        }
        m.dispose()
      }
    })
    this.model = null
    this.vrm = null
  }

  /** 相机取景：按模型身高把人物框在画面里，留出头顶与脚下一点余量 */
  _frameCamera() {
    const h = TARGET_HEIGHT * this.userScale
    const cy = this.modelBaseY + h * 0.52
    // 2.7 倍身高是试出来的：fov 30° 时可视高度 = 2 * dist * tan(15°) ≈ 0.536 * dist，
    // dist = 2.7h 时可视高度 ≈ 1.45h —— 人物占画面约七成，头顶和脚下都有余量。
    // 之前写 1.85h 时可视高度刚好等于身高，人物会顶天立地贴满整个画面。
    const dist = h * 2.7
    this.camera.fov = 30
    this.camera.position.set(this.userX * 0.6, cy + h * 0.04, dist)
    this.camera.lookAt(this.userX * 0.6, cy, 0)
    this.camera.updateProjectionMatrix()
  }

  applyTransform() {
    if (!this.model) return
    this.model.scale.setScalar(this.baseScale * this.userScale)
    this.model.position.y = this.modelBaseY
    this.model.position.x = this.userX
    this._frameCamera()
  }

  setScale(v) { this.userScale = Math.max(0.3, Math.min(3, v)); this.applyTransform() }
  setPosition(x, y) { this.userX = x * 0.01; this.userY = y; this.applyTransform() }

  resize() {
    if (!this.renderer || !this.camera) return
    const host = this.canvas.parentElement
    const r = host.getBoundingClientRect()
    const w = Math.max(1, Math.floor(r.width))
    const h = Math.max(1, Math.floor(r.height))
    // 浏览器缩放会改 devicePixelRatio，不跟着更新 setPixelRatio 的话
    // three.js 会按旧像素比渲染，放大后整只发虚
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.lastDpr = dpr
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // 全景模式下相机的 fov 与位置由全景场景自己管，不能被 _frameCamera 覆盖掉
    if (this.mode === 'panorama') this.camera.updateProjectionMatrix()
    else this._frameCamera()
  }

  /** 打开/关闭某类表情（模型没有该表情时静默跳过） */
  _setExpression(name, value) {
    const em = this.vrm && this.vrm.expressionManager
    if (!em) return false
    try {
      if (!em.expressionMap || !(name in em.expressionMap)) return false
      em.setValue(name, value)
      return true
    } catch { return false }
  }

  /** 当前模型可用的表情名（供界面列出） */
  expressionNames() {
    const em = this.vrm && this.vrm.expressionManager
    if (!em || !em.expressionMap) return []
    // 眨眼与口型是内部驱动的，不列给用户手动选
    return Object.keys(em.expressionMap).filter(n => !['blink', 'aa', 'ih', 'ou', 'ee', 'oh'].includes(n))
  }

  /** 手动切一个情绪表情，几秒后回到 neutral */
  setExpression(name) {
    if (!name) return false
    const ok = this._setExpression(name, 1)
    if (ok) {
      clearTimeout(this._exprTimer)
      this._exprTimer = setTimeout(() => {
        this._setExpression(name, 0)
        this._setExpression('neutral', 0)
      }, 3200)
    }
    return ok
  }

  /** 点一下：点个头 + 随机一个情绪表情 */
  /**
   * 播放动作。
   *
   * 与 Live2D 舞台保持同一套签名（`playMotion(group?, index?)` / `playMotionByName` /
   * `listMotions`），否则"让大模型指定动作"这件事在 3D 形象上会静默失效 ——
   * 调用方按 Liv2D 的用法传参，3D 这边收不到、也不报错，只是动作不对。
   *
   * 3D 这边分两种情况：
   *   · GLB 自带 AnimationClip（例如 Blender 导出的行走动画）→ 按名字/序号播那一整段
   *   · 只有 VRM 骨骼、没有 clip → 退化成"点头 + 换一个情绪表情"（原有行为）
   */
  playMotion(group, index) {
    const clips = (this.animations || [])

    // 有明确指定就在 clip 里找
    if (clips.length && this.mixer && (group !== undefined)) {
      const want = String(group || '').toLowerCase()
      let target = null
      if (Number.isInteger(index)) {
        target = clips[index] || clips.find(c => c.name.toLowerCase() === want) || null
      } else {
        target = clips.find(c => c.name.toLowerCase() === want)
          || clips.find(c => c.name.toLowerCase().includes(want))
          || null
      }
      const action = target ? (this._actionsByName || new Map()).get(target.name) : null
      if (action) {
        try {
          // 把其它段静音、只留这一段，避免多段叠在一起看起来像抽搐
          this.mixer.stopAllAction()
          action.reset()
          action.setLoop(THREE.LoopRepeat, Infinity)
          action.play()
          return { name: target.name }
        } catch { /* 落到下面的兜底 */ }
      }
    }

    // 没指定（或没有 clip）→ 保持原来的"点头 + 随机情绪"
    this.nodUntil = performance.now() + 900
    const list = this.expressionNames().filter(n => ['happy', 'relaxed', 'surprised', 'joy', 'fun'].includes(n))
    if (list.length) this.setExpression(list[Math.floor(Math.random() * list.length)])
    return { name: 'nod' }
  }

  /** 在已建的 mixer 里按 clip 名找 action（用自己维护的映射，不碰 three.js 的私有字段） */
  _clipByName(name) {
    return (this._actionsByName || new Map()).get(name) || null
  }

  async playMotionByName(name) {
    return this.playMotion(name)
  }

  /** 这个模型能播什么：GLB 动画段 + 可用的情绪表情 */
  listMotions() {
    const out = (this.animations || []).map((c, i) => ({ group: 'clip', index: i, name: c.name, file: '', duration: c.duration }))
    for (const n of this.expressionNames()) out.push({ group: 'expression', index: out.length, name: n, file: '', expression: true })
    return out
  }

  /* ========================================================================
   * ③ 程序化待机 与 ④ 导航模式：与 Live2D 舞台同名同语义
   *
   * 两套渲染器必须暴露同一组方法，app.js 是通过 activeStage() 盲调的。
   * 少一个方法，用户一切到 3D 形象就会报 "xxx is not a function"，
   * 而 3D 在项目里是二等公民，很容易漏测到这个路径。
   * ======================================================================*/

  markPointer() { this.lastPointerAt = Date.now() }

  startIdle(opts = {}) {
    this.idleWanted = true
    this.idleOn = true
    this._idleMotionEvery = Math.max(4000, Number(opts.motionEveryMs) || 14000)
    this._nextIdleMotionAt = performance.now() + (opts.firstMotionMs != null ? opts.firstMotionMs : 6000)
  }

  stopIdle() {
    this.idleWanted = false
    this.idleOn = false
    // 把待机写进去的位移/旋转收回来，否则模型会僵在半空或歪着
    if (this.model) {
      this.model.position.y = this.modelBaseY
      this.model.rotation.z = 0
    }
  }

  idleRunning() { return !!this.idleOn }

  /**
   * 设置背景风景。与 Live2D 那套共用 nav-visuals.js 的绘制，
   * 区别只是这里贴成 three 的 CanvasTexture 并挂到 scene.background。
   */
  async setScenery(src) {
    if (!this.scene) return false
    this.scenery = src || null
    if (!src) { this.scene.background = null; return true }

    if (src.kind === 'url') {
      try {
        const tex = await new Promise((resolve, reject) => {
          new THREE.TextureLoader().load(src.url, resolve, undefined, reject)
        })
        tex.colorSpace = THREE.SRGBColorSpace
        if (this._sceneryTex) { try { this._sceneryTex.dispose() } catch { /* 忽略 */ } }
        this._sceneryTex = tex
        this.scene.background = tex
        return true
      } catch {
        // 图挂了就退回程序化背景 —— 留一块纯色也比留个破图好看
        console.warn('[stage3d] 风景图加载失败，退回程序化背景：', src.url)
        this.scenery = { kind: 'procedural', spot: src.spot, city: src.city }
        return this.setScenery(this.scenery)
      }
    }

    const NV = window.WenlvNavVisuals
    if (!NV) return false
    const host = this.canvas.parentElement
    const rect = host.getBoundingClientRect()
    const cv = NV.drawScenery(src.spot, src.city, Math.max(2, rect.width), Math.max(2, rect.height))
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    if (this._sceneryTex) { try { this._sceneryTex.dispose() } catch { /* 忽略 */ } }
    this._sceneryTex = tex
    this.scene.background = tex
    return true
  }

  /**
   * 举牌。3D 这边贴一块带 canvas 纹理的平面到模型旁边。
   * 平面始终朝向相机（billboard），否则从侧面看就成一条线了。
   */
  setPlacard(text, opts = {}) {
    if (!this.scene) return false
    this.clearPlacard()
    const label = String(text || '').trim()
    if (!label) return false
    const NV = window.WenlvNavVisuals
    if (!NV) return false

    const cv = NV.drawPlacard(label, opts)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    // 300×170 的牌面 + 130 的杆，平面按同样的比例，字才不变形
    const W = 0.55
    const H = W * (cv.height / cv.width)
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }),
    )
    mesh.renderOrder = 20
    // 贴在模型右上方。模型是高矮不一的，所以按 targetHeight 换算，别写死绝对坐标
    mesh.position.set(0.62, this.modelBaseY + TARGET_HEIGHT * 0.86, 0.35)
    this.scene.add(mesh)
    this._placardMesh = mesh
    this.placard = { mesh, text: label, tex, w: cv.width, h: cv.height }
    return true
  }

  clearPlacard() {
    if (this._placardMesh && this.scene) {
      try {
        this.scene.remove(this._placardMesh)
        this._placardMesh.geometry.dispose()
        if (this._placardMesh.material.map) this._placardMesh.material.map.dispose()
        this._placardMesh.material.dispose()
      } catch { /* 忽略 */ }
    }
    this._placardMesh = null
    this.placard = null
  }

  /** 牌子朝向相机：3D 里不这么做，视角一转牌子就成了一条线 */
  _facePlacardToCamera() {
    if (!this._placardMesh || !this.camera) return
    this._placardMesh.quaternion.copy(this.camera.quaternion)
  }

  /**
   * 文本驱动口型：开始/追加说话内容（**不播放音频**）。
   * 与 live2d.js / lake.js 的同名方法行为一致 —— 外壳按统一接口调用。
   */
  talkTo(text) {
    const s = String(text == null ? '' : text)
    if (!s) { this.stopTalking(); return }
    if (!this.talking || !s.startsWith(this.talkText.slice(0, this.talkIndex))) {
      this.talkIndex = 0; this.talkAcc = 0
    }
    this.talkText = s
    if (this.talkIndex > s.length) this.talkIndex = s.length
    this.talking = true
    if (this.idle) this.idle.speaking = true   // 说话期间不插入待机小动作
  }

  /** 停止文本驱动口型 */
  stopTalking() {
    this.talking = false; this.talkText = ''; this.talkIndex = 0; this.talkAcc = 0
    if (this.idle) this.idle.speaking = false
  }

  /** 用音频驱动口型：读实时频谱能量 -> aa 表情 */
  async speak(url, audioEl) {
    if (!url) return
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume()

    audioEl.src = url
    audioEl.crossOrigin = 'anonymous'
    try {
      if (this.audioSource) { try { this.audioSource.disconnect() } catch { /* 忽略 */ } }
      this.audioSource = this.audioCtx.createMediaElementSource(audioEl)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.7
      this.audioSource.connect(this.analyser)
      this.analyser.connect(this.audioCtx.destination)
    } catch {
      // 同一个 <audio> 只能被 createMediaElementSource 绑一次；重复绑定就退化成"只出声不动嘴"
      this.analyser = null
    }

    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); this.targetMouthOpen = 0; resolve() }
      const err = (e) => { cleanup(); reject(e) }
      const cleanup = () => {
        audioEl.removeEventListener('ended', done)
        audioEl.removeEventListener('error', err)
      }
      audioEl.addEventListener('ended', done)
      audioEl.addEventListener('error', err)
      audioEl.play().catch(err)
    })
  }

  stopSpeaking(audioEl) {
    try { audioEl.pause() } catch { /* 忽略 */ }
    this.targetMouthOpen = 0
    this.mouthOpen = 0
  }

  _loop() {
    const step = () => {
      if (this._disposed) return
      this._raf = requestAnimationFrame(step)

      // 浏览器缩放会改 devicePixelRatio。window.resize 在个别路径上不一定来，
      // 每帧比一次最省心，成本就是一次比较。
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (dpr !== this.lastDpr) this.scheduleResize()

      const dt = Math.min(this.clock.getDelta(), 0.05)
      const now = performance.now()

      // ---- 全景模式：相机固定在球心、只改朝向，人物那套逻辑整段跳过 ----
      if (this.mode === 'panorama' && this.pano) {
        this.pano.applyToCamera(this.camera)
        this.renderer.render(this.scene, this.camera)
        return
      }

      if (this.model) {
        // ---- 视线跟随：把目标点挪到鼠标方位 ----
        if (this.lookTarget) {
          const t = performance.now() / 1000
          this.lookTarget.position.set(
            this.pointer.x * 1.2,
            this.modelBaseY + TARGET_HEIGHT * 0.95 - this.pointer.y * 0.5,
            1.6,
          )
          void t
        }

        // ---- 待机呼吸：整体轻微上下 + 侧向摆动（不依赖外部动画文件）----
        // 关掉待机时要把之前写进去的偏移归零，否则模型会停在半空中歪着
        if (this.idleOn) {
          this.idlePhase += dt * 1.15
          this.model.position.y = this.modelBaseY + Math.sin(this.idlePhase) * 0.006
          this.model.rotation.z = Math.sin(this.idlePhase * 0.5) * 0.012

          // 「待机时的动作」：隔一阵自己抽一个动画播，别一直杵着
          if (now >= this._nextIdleMotionAt) {
            this._nextIdleMotionAt = now + this._idleMotionEvery * (0.7 + Math.random() * 0.6)
            const clips = this.animations || []
            if (clips.length && !this.analyser) {
              this.playMotion('clip', Math.floor(Math.random() * clips.length))
            }
          }
        } else {
          this.model.position.y = this.modelBaseY
          this.model.rotation.z = 0
        }

        // 点头：在 nodUntil 内做一个阻尼正弦，结束后归零
        if (now < this.nodUntil) {
          const p = 1 - (this.nodUntil - now) / 900
          this.model.rotation.x = Math.sin(p * Math.PI * 2) * 0.10
        } else if (this.model.rotation.x !== 0) {
          this.model.rotation.x *= 0.85
          if (Math.abs(this.model.rotation.x) < 0.001) this.model.rotation.x = 0
        }

        // ---- 自动眨眼 ----
        if (this.vrm && this.vrm.expressionManager) {
          if (this.blinkPhase < 0) {
            this.blinkTimer -= dt
            if (this.blinkTimer <= 0) { this.blinkPhase = 0; this.blinkTimer = 2 + Math.random() * 3.5 }
          } else {
            this.blinkPhase += dt
            const T = 0.14
            const p = this.blinkPhase / T
            const v = p < 0.5 ? p * 2 : Math.max(0, (1 - p) * 2)
            this._setExpression('blink', Math.min(1, v))
            if (p >= 1) { this.blinkPhase = -1; this._setExpression('blink', 0) }
          }

          // ---- 口型：读频谱能量，平滑逼近 ----
          if (this.analyser) {
            const buf = new Uint8Array(this.analyser.frequencyBinCount)
            this.analyser.getByteFrequencyData(buf)
            let sum = 0
            const from = 2
            const to = Math.min(buf.length, 48)
            for (let i = from; i < to; i++) sum += buf[i]
            this.targetMouthOpen = Math.min(1, (sum / ((to - from) * 255)) * 2.6)
          } else if (this.talking) {
            // 文本驱动的"假口型" —— 与 live2d.js / lake.js 同一套常量与思路。
            // 字幕一边生成一边吐，而 TTS 要等整段写完才合成，这段时间用它顶着。
            const nowMs = performance.now()
            const dtTalk = this.lastTick ? Math.min(0.1, (nowMs - this.lastTick) / 1000) : 0
            this.lastTick = nowMs
            this.talkAcc += dtTalk
            const CH = 0.18
            const len = this.talkText.length
            // 额度封顶：文本是流式的，两段之间攒下的时间不能被一次烧完，
            // 否则新一段一到就被瞬间"读完"，嘴反而不动（live2d.js 里实测踩过）
            if (this.talkAcc > CH) this.talkAcc = CH
            while (this.talkAcc >= CH && this.talkIndex < len) { this.talkAcc -= CH; this.talkIndex++ }
            const ch = this.talkIndex < len ? this.talkText[this.talkIndex] : ''
            if (!ch || /[\s。，、！？；：…—,\.!\?;:"'（）()《》「」【】]/.test(ch)) {
              this.targetMouthOpen = 0
            } else {
              this.targetMouthOpen = 0.25 + ((ch.charCodeAt(0) * 37) % 60) / 100
            }
          } else {
            this.lastTick = 0
            this.targetMouthOpen = 0
          }
          this.mouthOpen += (this.targetMouthOpen - this.mouthOpen) * 0.35
          // VRM 的 'aa' 是元音口型；没有就退到 'ou'，再没有就跳过
          if (!this._setExpression('aa', this.mouthOpen)) this._setExpression('ou', this.mouthOpen * 0.8)
        }
      }

      // 播放 glTF 动画（Blender 导出的移动动画走这条）
      if (this.mixer) {
        try { this.mixer.update(dt) } catch { /* 动画异常不该打断渲染 */ }
      }

      if (this.vrm && this.vrm.update) {
        try { this.vrm.update(dt) } catch { /* 单个模型的骨骼异常不该打断整帧 */ }
      }
      // 牌子每帧转向相机，否则视角一动它就成一条线了
      if (this._placardMesh) this._facePlacardToCamera()
      this.renderer.render(this.scene, this.camera)
    }
    step()
  }

  /**
   * 地理标记：在角色脚下的地面上画一个指北环 + 指向景点的箭头。
   *
   * 为什么贴地画、而不是在角色旁边竖一个图钉：
   *   ① 相机是按身高取景的，往旁边放很容易出画（尤其窄屏）；
   *   ② "往哪个方向走"本来就是地面上的信息，贴在脚下最直观。
   * 距离与景点名由页面上的 HUD 文字承担 —— three.js 里画中文要加载字体，
   * 为一行字多下几百 KB 不值得。
   *
   * 方位角约定：0° 正北 = -Z，90° 正东 = +X，与地理方位一致。
   *
   * @param {{bearingDeg:number,label:string,distanceText:string}|null} info 传 null 清除标记
   */
  setGeoMarker(info) {
    if (!this.scene) return

    // 清除
    if (!info || !Number.isFinite(info.bearingDeg)) {
      if (this.geoMarker) {
        this.scene.remove(this.geoMarker)
        this._disposeObject(this.geoMarker)
        this.geoMarker = null
      }
      return
    }

    if (!this.geoMarker) {
      const g = new THREE.Group()
      g.name = 'geo-marker'

      // 指北环：贴地的细圆环，给箭头一个"参照系"
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.008, 8, 64),
        new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.55 }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.004
      g.add(ring)

      // 方位箭头：一个朝 -Z 的小圆锥，整体绕 Y 旋转到目标方位
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffcf70 }),
      )
      // 圆锥默认朝 +Y，先转成朝 -Z（即"北"），再由外层 group 旋转到实际方位
      arrow.rotation.x = -Math.PI / 2
      arrow.position.set(0, 0.02, -0.55)
      g.add(arrow)

      // 四个正方向的小刻度，让人能看出环的朝向
      const tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
      for (let i = 0; i < 4; i++) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, i === 0 ? 0.09 : 0.05), tickMat)
        const a = (i * Math.PI) / 2
        tick.position.set(Math.sin(a) * 0.55, 0.004, -Math.cos(a) * 0.55)
        tick.rotation.y = -a
        g.add(tick)
      }

      this.geoMarker = g
      this.scene.add(g)
    }

    // bearing 0°(北) → -Z：绕 Y 转 -θ 即可（three.js 绕 Y 正转会把 -Z 转向 -X 方向）
    this.geoMarker.rotation.y = -(info.bearingDeg * Math.PI) / 180
  }

  /** 递归释放几何体与材质，避免反复切形象时显存泄漏 */
  _disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry) { try { o.geometry.dispose() } catch { /* 忽略 */ } }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) { try { m.dispose() } catch { /* 忽略 */ } }
      }
    })
  }

  /* ========================================================================
   * 景区全景模式
   * ======================================================================*/

  /**
   * 用一张等距柱状全景图构建景区场景。
   *
   * @param {object} o
   * @param {string} [o.url]      全景图地址（走 /api/pano/image/:id）
   * @param {string} [o.depthUrl] 深度高度图地址；给了就做起伏浮雕，没给就是普通环境球
   * @param {HTMLCanvasElement} [o.canvas] 也可以是现成的画布（程序化生成的全景走这条）
   */
  async buildPanorama({ url, depthUrl, canvas, label = '', sourceKind = 'unknown' } = {}) {
    if (!this.scene) await this.init()
    if (!this.pano) this.pano = new PanoramaScene()

    if (url) await this.pano.setPanoramaUrl(url, { label, sourceKind })
    else if (canvas) await this.pano.setPanoramaSource(canvas, { label, sourceKind })
    else throw new Error('buildPanorama 需要 url 或 canvas')

    let depthError = null
    if (depthUrl) {
      try {
        await this.pano.setDepthUrl(depthUrl)
      } catch (e) {
        // 深度拿不到不该让整个场景失败：退化成普通环境球，并把原因带回去给界面
        this.pano.clearDepth()
        depthError = e.message
      }
    } else {
      this.pano.clearDepth()
    }

    if (!this._panoAdded) {
      this.scene.add(this.pano.group)
      this._panoAdded = true
    }
    this.enterPanorama()
    return { ...(this.pano.report || {}), depthError, label, sourceKind }
  }

  enterPanorama() {
    if (!this.pano || !this.pano.ready) return false
    this.mode = 'panorama'
    if (this.model) this.model.visible = false
    if (this.geoMarker) this.geoMarker.visible = false
    if (this.camera) {
      // 人物像是 30° 的窄视场（把人拍满），环视要用 70° 的宽视场，
      // 否则站在球心里看什么都像望远镜。
      this.camera.fov = 70
      this.camera.near = 0.1
      this.camera.far = 300
      this.camera.updateProjectionMatrix()
    }
    return true
  }

  exitPanorama() {
    this.mode = 'character'
    if (this.model) this.model.visible = true
    if (this.geoMarker) this.geoMarker.visible = true
    this._frameCamera()
    return true
  }

  disposePanorama() {
    if (this.pano) {
      if (this._panoAdded) { this.scene.remove(this.pano.group); this._panoAdded = false }
      this.pano.dispose()
      this.pano = null
    }
    this.exitPanorama()
  }

  destroy() {
    this._disposed = true
    if (this._raf) cancelAnimationFrame(this._raf)
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf)
    if (this.ro) { try { this.ro.disconnect() } catch { /* 忽略 */ } }
    clearTimeout(this._exprTimer)
    if (this.geoMarker) { this._disposeObject(this.geoMarker); this.geoMarker = null }
    this.clearPlacard()
    if (this._sceneryTex) { try { this._sceneryTex.dispose() } catch { /* 忽略 */ } }
    this._sceneryTex = null
    this._unload()
    if (this.renderer) { try { this.renderer.dispose() } catch { /* 忽略 */ } }
    this.ready = false
  }
}
