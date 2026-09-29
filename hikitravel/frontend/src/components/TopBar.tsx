interface Props {
  title: string | null
  status: string
  hasPlan: boolean
  dirty: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onSave: () => void
  onExport: () => void
}

export default function TopBar({
  title,
  status,
  hasPlan,
  dirty,
  theme,
  onToggleTheme,
  onSave,
  onExport,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar__in">
        <span className="brand">文旅智能助手</span>

        {hasPlan && title && (
          <span className="topbar__trip">
            <b>{title}</b>
            <span className="meta">{dirty ? '有改动未保存' : status}</span>
          </span>
        )}

        <div className="topbar__acts">
          {/* 构建时间：用来一眼确认浏览器加载的是不是最新前端（排查缓存问题） */}
          <span className="meta topbar__build">构建 {__BUILD_TIME__}</span>
          <button className="btn btn--ghost btn--sm" onClick={onSave} disabled={!hasPlan}>
            保存
          </button>
          <button className="btn btn--ghost btn--sm" onClick={onExport} disabled={!hasPlan}>
            导出
          </button>
          <button className="iconbtn" onClick={onToggleTheme} title="切换外观" aria-label="切换外观">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4.4" />
                  <path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5.1 5.1l1.8 1.8M17.1 17.1l1.8 1.8M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8" />
                </>
              ) : (
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              )}
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
