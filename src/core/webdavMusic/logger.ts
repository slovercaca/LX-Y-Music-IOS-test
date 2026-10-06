import { log } from '@/utils/log'
import settingState from '@/store/setting/state'

// P1-5（2026-10-06）：JSON.stringify 对循环引用对象会抛 TypeError，
// 调用点常在 catch 里打日志——日志抛错会掩盖原始错误。加兜底。
const safeStringify = (v: unknown): string => {
  if (typeof v === 'string') return v
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
