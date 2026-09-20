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
import { requestGenerate, setPreference } from './bridge'
import { focusTarget } from './focus'

// 把桥接接口一起挂到全局：外壳（词云）通过它把点选的条件送进工作台、
// 要求工作台生成一次、或者滚到方案里对应的那一块。
// 见 bridge.ts 与 focus.ts 的说明。
export { setPreference, requestGenerate, focusTarget as focus }

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

export function mount(target: HTMLElement | string): boolean {
  const el =
    typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
  if (!el) {
    console.warn('[wenlv-planner] 没找到挂载容器：', target)
    return false
  }
  if (el.dataset.wenlvMounted === '1') return true // 防重复挂载
  el.dataset.wenlvMounted = '1'

  ReactDOM.createRoot(el).render(
    <Boundary>
      <ConfigProvider
        locale={zhCN}
        theme={{
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
        }}
      >
        <App />
      </ConfigProvider>
    </Boundary>,
  )
  return true
}
