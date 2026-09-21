import PlannerPage from './pages/PlannerPage'

/**
 * standalone —— 这份实例是"嵌进别处"的副本（比如底部对话框的输出区）。
 *
 * 为什么需要这个开关：工作台里有两个地方订阅了外壳的广播
 * （`subscribePreference` 收词云点选、`subscribeGenerate` 收"生成一次"）。
 * 外壳里同时存在两份实例时，外壳喊一嗓子**两份都会响应** ——
 * 词云点一下，两份表单都被写；要求生成一次，两份都去提交，直接打出两次 /api/plan。
 * 所以内嵌那一份必须"自足"：只听自己的，不去接外壳的广播。
 */
export default function App({ standalone = false }: { standalone?: boolean }) {
  return <PlannerPage standalone={standalone} />
}
