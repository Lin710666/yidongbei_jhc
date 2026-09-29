import type { TravelPlan } from '../types/plan'
import { severityOf } from '../lib/format'

interface Props {
  plan: TravelPlan
  /** 正在生成中：体检可能还没跑完（行程会先于体检到达） */
  loading?: boolean
  /** 体检是否已经有结论（收到 done 事件，或从历史计划打开） */
  settled?: boolean
  notify: (text: string) => void
}

/** 规划体检：系统只提示、不擅自改行程 */
export default function ChecksCard({ plan, loading, settled, notify }: Props) {
  const hasChecks = plan.checks != null
  /* 三种状态必须分清，别把「没跑完」说成「没问题」：
       · running      行程已经可以先看了，体检还在跑
       · interrupted  生成被取消/中断，体检没有结论
       · 有结论       可能是 0 条，也可能是 N 条
     原来只判「正在生成中」，于是用户一点取消、loading 变回 false，
     就掉进「未发现明显问题。」—— 明明体检压根没跑完，这比不显示还误导。 */
  const running = Boolean(loading) && !hasChecks
  const interrupted = !hasChecks && !loading && !settled

  const issues = (plan.checks?.issues ?? []).map((i) => ({
    category: i.category as string,
    severity: severityOf(i.severity),
    message: i.message,
    suggestion: i.suggestion,
  }))

  const head = running ? '进行中…' : interrupted ? '未完成' : `${issues.length} 条`

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">规划体检</h2>
        <span className="meta">{head}</span>
      </div>
      {running ? (
        <p className="meta">
          行程已经可以先看了，体检还在跑——它会检查绕路、重复安排、时间是否过满，
          结论出来后自动补在这里。
        </p>
      ) : interrupted ? (
        <p className="meta">
          本次生成被取消或中途断开，体检没有跑完，所以这里<b>没有结论</b>——
          不代表行程没问题。可以点「重试」再走一遍。
        </p>
      ) : issues.length === 0 ? (
        <p className="meta">未发现明显问题。</p>
      ) : (
        <div className="issues">
          {issues.map((it, i) => (
            <div className="issue" key={i}>
              <span className={`issue__sev sev-${it.severity}`} />
              <div className="issue__body">
                <div className="issue__cat">{it.category}</div>
                <p className="issue__msg">{it.message}</p>
                {it.suggestion && <p className="issue__msg faint">建议：{it.suggestion}</p>}
                <div className="issue__acts">
                  <span className="issue__hint">可按建议调整条件后重新生成</span>
                  <button className="btn btn--muted" onClick={() => notify('已保持原样')}>
                    忽略
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
