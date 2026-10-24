import { log } from '@/utils/log'
import settingState from '@/store/setting/state'

// P1-5（2026-10-06）：JSON.stringify 对循环引用对象会抛 TypeError，
// 调用点常在 catch 里打日志——日志抛错会掩盖原始错误。加兜底。
const safeStringify = (v: unknown): string => {
  // 2026-10-24：undefined 直接返回 'undefined' 字符串——此前
  // JSON.stringify(undefined) 返回 undefined 值，join 后正文变空，
  // 日志页只剩“时间 + ERROR”一行。
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return v
  // 低：Error 的 message/stack 不可枚举，JSON.stringify 只得 {}——失败
  // 日志丢光原因（多处诊断路径全中）。先展开 Error 再序列化。
  if (v instanceof Error) {
    const anyErr = v as any
    return `${v.name}: ${v.message}${anyErr?.status ? ` (status ${anyErr.status})` : ''}${anyErr?.code ? ` [${anyErr.code}]` : ''}`
  }
  try {
    return JSON.stringify(v)
  } catch {
    try {
      return String(v)
    } catch {
      return '[unserializable]'
    }
  }
}

export const webDAVLog = {
  info(...msgs: unknown[]) {
    // P2（2026-10-06）：global.lx 可能为 undefined（极早期调用），加可选链
    if (!global.lx?.isEnableLog) return
    if (!settingState.setting['common.isEnableWebDAVLog']) return
    log.info(`[WebDAV] ${msgs.map(safeStringify).join(' ')}`)
  },
  warn(...msgs: unknown[]) {
    if (!global.lx?.isEnableLog) return
    if (!settingState.setting['common.isEnableWebDAVLog']) return
    log.warn(`[WebDAV] ${msgs.map(safeStringify).join(' ')}`)
  },
  error(...msgs: unknown[]) {
    if (!global.lx?.isEnableLog) return
    if (!settingState.setting['common.isEnableWebDAVLog']) return
    log.error(`[WebDAV] ${msgs.map(safeStringify).join(' ')}`)
  },
}
