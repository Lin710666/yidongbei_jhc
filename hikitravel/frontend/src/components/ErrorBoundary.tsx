import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 顶层兜底。
 *
 * 为什么必须有：React 在渲染期一抛错，会把**整棵树卸载掉** —— 没有这个组件时
 * 用户看到的是整页白屏，连「重试」都点不到。而这一版的规划数据是从 SSE 流
 * 一条条推过来的（不像历史计划那条路会先做字段兜底），少一个字段就会在渲染期
 * 炸（例如读 `plan.daily_plans.some(...)`）。
 *
 * 这里把错误如实显示出来，并给一条回到可用状态的出路。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[界面渲染出错]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash__card">
          <h1 className="crash__title">界面出错了</h1>
          <p className="crash__msg">{error.message || String(error)}</p>
          <p className="crash__hint">
            已经生成好的规划还存在后端（`/api/plans` 里有），刷新页面就能继续看。
          </p>
          <div className="crash__acts">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button className="btn btn--ghost" onClick={() => this.setState({ error: null })}>
              重试渲染
            </button>
          </div>
        </div>
      </div>
    )
  }
}
