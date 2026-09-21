/**
 * 嵌入入口：把工作台挂进 AIRI 外壳（public/index.html）里的某个容器。
 *
 * 和 main.tsx 的区别，正是"贴合"的三件事：
 *
 *  1. **不导入 `antd/dist/reset.css`，也不导入 `index.css`**。
 *     那两个会改 body / #root / h1~h6 的全局样式，而外壳是另一套设计系统
 *     （深色玻璃拟态），一起加载就会互相打架——外壳的排版被 antd 的 reset 顶掉。
 *     组件本身不缺 reset 也能正常渲染，所以这里干脆不带。
 *
 *  2. **用 ConfigProvider 切 darkAlgorithm，主色取外壳的 `--wenlv`**。
 *     外壳 CSS 里写着「文旅第二识别色：青绿（山水），只在『文旅』语义处点缀」，
 *     值是 oklch(76% 0.11 178)，换算成 sRGB 就是 #54c8b1。用同一个色，
 *     工作台的按钮/选中态就和外壳的文旅语义同源，不会像塞进来的一张白纸。
 *     其余 token 也照外壳的 --surface / --border / --text 对齐。
 *
 *  3. **只导出 mount()，不自己找 #root**。挂载时机交给外壳决定，
 *     并且做了重复挂载保护。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import './embed.css'
import App from './App'
import PlanView from './components/PlanView'
import { requestGenerate, setPreference, subscribePlan } from './bridge'
import { focusTarget } from './focus'

// 把桥接接口一起挂到全局：外壳（词云 / 对话框）通过它把点选的条件送进工作台、
// 要求工作台生成一次、订阅方案、把方案渲染到指定容器、或者滚到方案里对应的那一块。
// 见 bridge.ts / focus.ts 的说明。
// 注意 renderPlan 自己是 export function，不要在这里重复列出（会报重复声明）。
export { setPreference, requestGenerate, subscribePlan, focusTarget as focus }

/**
 * 渲染出错时把原因写在原地。
 *
 * 为什么需要：React 渲染期抛的错**不会**被 mount() 外面的 try/catch 接住
 * （render 是异步的），结果是容器被标成"已挂载"、内容却是空的 ——
 * 面板一片空白且没有任何提示。这个边界把错误显示出来，至少让人知道是崩了、崩在哪。
 */
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="planner-state err">
          工作台渲染出错：{String(this.state.error.message || this.state.error)}
        </div>
      )
    }
    return this.props.children
  }
}

/** 统一的那套暗色主题 token（工作台与"对话框里的方案"共用同一份，样式才不会两样） */
const WENLV_THEME = {
  algorithm: theme.darkAlgorithm,
  token: {
    // 与外壳 --wenlv 同色
    colorPrimary: '#54c8b1',
    colorInfo: '#54c8b1',
    // 与外壳 --surface / --border / --text 同源
    colorBgContainer: 'rgba(255, 255, 255, 0.035)',
    colorBgElevated: '#191a1d',
    colorBorder: 'rgba(255, 255, 255, 0.09)',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.07)',
    colorText: 'rgba(255, 255, 255, 0.94)',
    colorTextSecondary: 'rgba(255, 255, 255, 0.62)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.38)',
    borderRadius: 10,
    fontSize: 12.5,
    fontFamily: 'inherit',
  },
}

function scopeEl(target: HTMLElement | string): HTMLElement | null {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
  if (el) el.classList.add('wenlv-scope')   // embed.css 的作用域标记
  return el
}

/**
 * 把**文旅工作台那套方案视图**渲染到任意容器里（比如底部对话框的输出气泡）。
 *
 * 为什么不做"看起来像"的样式复刻：老板要的是"对话框的输出内容换成文旅工作台的样式"，
 * 而复刻永远会有偏差 —— 表格边框、分档标签、按钮位置、换景点/换餐厅的交互，
 * 甚至导航/点评/美团这些跳转按钮，都是 PlanView 组件里的行为。
 * 直接挂同一个组件，两处天然一模一样，以后组员改样式也不会只改到一边。
 */
export function renderPlan(target: HTMLElement | string, plan: unknown): boolean {
  const el = scopeEl(target)
  if (!el || !plan) return false
  const host = el as HTMLElement & { __wenlvPlanRoot?: ReactDOM.Root }
  host.__wenlvPlanRoot?.unmount?.()
  const root = ReactDOM.createRoot(el)
  host.__wenlvPlanRoot = root
  root.render(
    <Boundary>
      <ConfigProvider locale={zhCN} theme={WENLV_THEME}>
        <PlanView plan={plan as never} />
      </ConfigProvider>
    </Boundary>,
  )
  return true
}

export function mount(target: HTMLElement | string): boolean {
  const el = scopeEl(target)
  if (!el) {
    console.warn('[wenlv-planner] 没找到挂载容器：', target)
    return false
  }
  if (el.dataset.wenlvMounted === '1') return true // 防重复挂载
  el.dataset.wenlvMounted = '1'

  ReactDOM.createRoot(el).render(
    <Boundary>
      <ConfigProvider locale={zhCN} theme={WENLV_THEME}>
        <App />
      </ConfigProvider>
    </Boundary>,
  )
  return true
}

/**
 * 把**整个文旅工作台**（就是「文旅」页签里那一整块）挂进任意容器。
 *
 * 和 renderPlan 的区别：
 *   renderPlan     只挂 PlanView，用来把**已经生成好的方案**显示到对话框里；
 *   renderWorkbench 挂的是 App（PreferenceForm + 结果 + 地图），
 *                   也就是工作台本身 —— 表单、下拉、日期选择器、生成按钮
 *                   全都在，是真能填真能点的。
 *
 * 为什么要"真挂一份"，而不是在外壳里照着画一套像的：
 * 老板的原话是「文旅工作台也是图二一模一样的样子在输出框里面」。
 * 照着画永远会有偏差（字段顺序、下拉候选、圆角、输入框里的 placeholder、
 * 日期选择器的样子……），而且以后组员改了表单，外壳那份不会跟着变。
 * 直接挂同一个组件，两处天然一模一样，一行复刻代码都不用写。
 *
 * `standalone` 那一份不接外壳广播（见 App.tsx 的注释）：
 * 外壳里同时存在两份实例，广播是"谁订阅谁收到"，两份都收会导致
 * 点一次生成打两次 /api/plan。
 */
export function renderWorkbench(target: HTMLElement | string): boolean {
  const el = scopeEl(target)
  if (!el) {
    console.warn('[wenlv-planner] 没找到工作台容器：', target)
    return false
  }
  const host = el as HTMLElement & { __wenlvAppRoot?: ReactDOM.Root }
  host.__wenlvAppRoot?.unmount?.()
  const root = ReactDOM.createRoot(el)
  host.__wenlvAppRoot = root
  root.render(
    <Boundary>
      <ConfigProvider locale={zhCN} theme={WENLV_THEME}>
        <App standalone />
      </ConfigProvider>
    </Boundary>,
  )
  return true
}
