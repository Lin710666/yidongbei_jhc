import { useCallback, useState } from 'react'

export interface Toast {
  id: number
  text: string
}

let seq = 0

/** 轻量提示：只做一件事——把一条消息显示 2 秒后收回。 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((text: string) => {
    const id = ++seq
    setToasts((list) => [...list, { id, text }])
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id))
    }, 2000)
  }, [])

  return { toasts, notify }
}
