/**
 * 词云 ↔ 工作台 的桥。
 *
 * 为什么需要这一层：词云（外壳）原来把点选的「目的地 / 预算 / 同行人群 / 兴趣 /
 * 饮食禁忌」填进右侧面板的表单。那个面板现在换成了组员的工作台，旧表单被收了起来
 * —— 于是点词云变成"点了没反应"：数据进了看不见的表单，只有底下一行字幕。
 *
 * 这里放一个极小的发布订阅：外壳调 setPreference()/requestGenerate()，
 * 工作台的表单订阅后把值写进自己的 antd Form。两边不直接互相引用，
 * 所以组员那套单独跑（不走嵌入）时也完全不受影响 —— 没人调用就只是没人调用。
 */
import type { UserPreference } from './types/preference'

type Patch = Partial<UserPreference>
type Listener = (patch: Patch) => void

let current: Patch = {}
const listeners = new Set<Listener>()
const genListeners = new Set<() => void>()

/** 外壳用：把词云上点到的条件同步给工作台表单（增量合并） */
export function setPreference(patch: Patch): void {
  current = { ...current, ...patch }
  for (const fn of listeners) fn(current)
}

/** 工作台用：订阅外部同步过来的条件 */
export function subscribePreference(fn: Listener): () => void {
  listeners.add(fn)
  fn(current) // 订阅时先补一次当前值，避免"桥比表单先就绪"时丢数据
  return () => {
    listeners.delete(fn)
  }
}

export function getPreference(): Patch {
  return current
}

/** 外壳用：请求工作台按当前表单直接生成一次（词云点「个性化方案」时调） */
export function requestGenerate(): void {
  for (const fn of genListeners) fn()
}

/** 工作台用：订阅"要求生成" */
export function subscribeGenerate(fn: () => void): () => void {
  genListeners.add(fn)
  return () => {
    genListeners.delete(fn)
  }
}
