import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import LeftRail from './components/LeftRail'
import WorkColumn from './components/WorkColumn'
import MapPane from './components/MapPane'
import Toasts from './components/Toasts'
import { usePlanner } from './hooks/usePlanner'
import { useToasts } from './hooks/useToasts'

type Theme = 'light' | 'dark'

export default function App() {
  const { toasts, notify } = useToasts()
  const planner = usePlanner(notify)
  /* 当前查看的是第几天：中栏的日期切换与右栏的「替换第 N 天」共用 */
  const [day, setDay] = useState(0)
  /* 地图联动：左侧点中的行程项（地图点序号），null 表示未选中 */
  const [focus, setFocus] = useState<string | null>(null)

  /* 外观：跟随系统，用户手动切过就记住 */
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('tp-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('tp-theme', theme)
  }, [theme])

  /* 换了一单才回到第 1 天，避免停在上一个行程的「第 3 天」。
     这里**不能**盯着 plan_id：同一单里终稿会换一个新的 plan_id
     （体检判定有硬伤时会重新生成、带新 uuid），那样用户正翻到第 3 天，
     终稿一到达就被弹回第 1 天——而这件事几乎每一单都会发生。 */
  useEffect(() => {
    setDay(0)
    setFocus(null)
  }, [planner.viewKey])

  /* day 可能越界：换了一单之后天数变少、或深链打开一份更短的规划。
     收敛成合法下标再往下传，否则会「标题写第 5 天、内容却是第 1 天」。 */
  const dayCount = planner.plan?.daily_plans.length ?? 0
  const safeDay = dayCount > 0 ? Math.min(day, dayCount - 1) : 0

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    [],
  )

  return (
    <>
      {/* 应用外壳：顶栏 + 三栏，各栏独立滚动（仿 Wanderlog） */}
      <div className="app">
        <TopBar
          title={planner.plan?.summary ?? null}
          status="已保存"
          hasPlan={Boolean(planner.plan)}
          dirty={planner.dirty}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSave={planner.save}
          onExport={planner.exportJson}
        />

        <div className="shell">
          <LeftRail planner={planner} notify={notify} />
          <WorkColumn
            planner={planner}
            notify={notify}
            day={safeDay}
            setDay={setDay}
            focus={focus}
            setFocus={setFocus}
          />
          <MapPane planner={planner} day={safeDay} theme={theme} focus={focus} />
        </div>
      </div>

      <Toasts toasts={toasts} />
    </>
  )
}
