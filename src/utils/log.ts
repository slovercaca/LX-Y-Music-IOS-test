// import { requestStoragePermission } from '@/utils/common'
import {
  temporaryDirectoryPath,
  existsFile,
  appendFile,
  unlink,
  writeFile,
  readFile,
  stat,
  read,
} from '@/utils/fs'

const logPath = temporaryDirectoryPath + '/error.log'
const sourceTestLogPath = temporaryDirectoryPath + '/source_test.log'
const MAX_LOG_SIZE = 5 * 1024 * 1024
const READ_LIMIT = 1 * 1024 * 1024

const trimLogFile = async() => {
  try {
    const info = await stat(logPath)
    if (info.size > MAX_LOG_SIZE) {
      await unlink(logPath)
      await writeFile(logPath, '')
    }
  } catch { /* ignore */ }
}

// 4-10：source_test.log 加上限（与主日志同口径 trim，此前只 append 无上限）
const trimSourceTestLogFile = async() => {
  try {
    const info = await stat(sourceTestLogPath)
    if (info.size > MAX_LOG_SIZE) {
      await unlink(sourceTestLogPath)
      await writeFile(sourceTestLogPath, '')
    }
  } catch { /* ignore */ }
}

// 4-10：日志写操作串行化（单队列）——此前 append 与 trim 各自 void 并发，
// trim 的 unlink+重建可能与在途 append 竞态丢日志
let logWriteQueue: Promise<void> = Promise.resolve()
const runLogSerial = (job: () => Promise<void>): Promise<void> => {
  logWriteQueue = logWriteQueue.then(job, job).catch(() => {})
  return logWriteQueue
}

const logTools = {
  tempLog: [] as Array<{ time: string, type: 'LOG' | 'WARN' | 'ERROR', text: string }> | null,
  writeLog(msg: string) {
    console.log(msg)
    void runLogSerial(async() => {
      await appendFile(logPath, '\n----lx log----\n' + msg)
      await trimLogFile()
    })
  },
  async initLogFile() {
    try {
      let isExists = await existsFile(logPath)
      // console.log(isExists)
      if (!isExists) await writeFile(logPath, '')
      // 启动时强制清理：无论日志开关状态，都截断超限文件
      // 防止老版本积累的几百兆日志残留
      await runLogSerial(trimLogFile)
      if (this.tempLog?.length) {
        this.writeLog(
          this.tempLog.map((m) => `${m.time} ${m.type} ${m.text}`).join('\n----lx log----\n'),
        )
      }
      this.tempLog = null
    } catch (err) {
      console.log(err)
    }
  },
}

export const init = async() => {
  return logTools.initLogFile()
}

export const getLogs = async() => {
  try {
    const info = await stat(logPath)
    if (info.size > READ_LIMIT) {
      const position = Math.max(0, info.size - READ_LIMIT)
      // 4-10：字节偏移截断可能落在多字节字符中间——读 base64 原字节，
      // 向前跳过续字节（0x80–0xBF）找到字符边界再解码，避免首字符乱码
      const b64 = await read(logPath, READ_LIMIT, position, 'base64')
      const buf = Buffer.from(b64, 'base64')
      let start = 0
      while (start < buf.length && start < 3 && buf[start] >= 0x80 && buf[start] < 0xC0) start++
      return buf.subarray(start).toString('utf8')
    }
  } catch { /* ignore */ }
  return readFile(logPath)
}

export const clearLogs = async() => {
  return unlink(logPath).then(async() => writeFile(logPath, ''))
}

// 2026-10-24：日志正文永不为空。旧实现里 Error 无 stack/message 时
// `m.stack ?? m.message` 得 undefined、JSON.stringify(undefined) 得
// undefined，join 后正文是空串，日志页就只剩“时间 + ERROR”一行，
// 真错彻底丢失——上传设置/音源失败那次就是这么丢的。
const formatLogArg = (m: any): string => {
  if (typeof m === 'string') return m
  if (m instanceof Error) return m.stack ?? m.message ?? `Error(${m.name || 'unknown'}) (no stack/message)`
  if (m === undefined) return 'undefined'
  if (m === null) return 'null'
  try {
    const s = JSON.stringify(m)
    return s === undefined ? 'undefined' : s
  } catch {
    return String(m)
  }
}

const formatLogMsg = (msgs: any[]): string => {
  const msg = msgs.map(formatLogArg).join(' ')
  // 无参数、空字符串参数时也给一个占位，绝不出现裸“时间 + 类型”行
  return msg.trim() ? msg : '(empty log message)'
}

export const log = {
  info(...msgs: any[]) {
    if (!global.lx.isEnableLog) return
    const msg = formatLogMsg(msgs)
    if (msg.startsWith('%c')) return
    const time = new Date().toLocaleString()
    if (logTools.tempLog) {
      logTools.tempLog.push({ type: 'LOG', time, text: msg })
    } else logTools.writeLog(`${time} LOG ${msg}`)
  },
  warn(...msgs: any[]) {
    if (!global.lx.isEnableLog) return
    const msg = formatLogMsg(msgs)
    const time = new Date().toLocaleString()
    if (logTools.tempLog) {
      logTools.tempLog.push({ type: 'WARN', time, text: msg })
    } else logTools.writeLog(`${time} WARN ${msg}`)
  },
  error(...msgs: any[]) {
    if (!global.lx.isEnableLog) return
    const msg = formatLogMsg(msgs)
    const time = new Date().toLocaleString()
    if (logTools.tempLog) {
      logTools.tempLog.push({ type: 'ERROR', time, text: msg })
    } else {
      logTools.writeLog(`${time} ERROR ${msg}`)
    }
  },
}

export const getSourceTestLogs = async() => {
  return readFile(sourceTestLogPath)
}

export const clearSourceTestLogs = async() => {
  return unlink(sourceTestLogPath).then(async() => writeFile(sourceTestLogPath, ''))
}

export const sourceTestLog = {
  info(...msgs: any[]) {
    const msg = msgs
      .map((m) =>
        typeof m == 'string' ? m : m instanceof Error ? (m.stack ?? m.message) : JSON.stringify(m),
      )
      .join(' ')
    if (msg.startsWith('%c')) return
    const time = new Date().toLocaleString()
    console.log(`[源测试] ${msg}`)
    void runLogSerial(async() => {
      await appendFile(sourceTestLogPath, `\n----lx source test log----\n${time} LOG ${msg}`)
      await trimSourceTestLogFile()
    })
  },
}

/*
if (process.env.NODE_ENV !== 'development') {
  const logPath = externalDirectoryPath + '/debug.log'

  let tempLog = []

  const log = window.console.log
  const error = window.console.error
  const warn = window.console.warn

  const writeLog = msg => appendFile(logPath, '\n' + msg)

  window.console.log = (...msgs) => {
    log(...msgs)
    const msg = msgs.map(m => typeof m == 'string' ? m : JSON.stringify(m)).join(' ')
    if (msg.startsWith('%c')) return
    const time = new Date().toLocaleString()
    if (tempLog) {
      tempLog({ type: 'LOG', time, text: msg })
    } else writeLog(`${time} LOG ${msg}`)
  }
  window.console.error = (...msgs) => {
    error(...msgs)
    const msg = msgs.map(m => typeof m == 'string' ? m : JSON.stringify(m)).join(' ')
    const time = new Date().toLocaleString()
    if (tempLog) {
      tempLog({ type: 'ERROR', time, text: msg })
    } else writeLog(`${time} ERROR ${msg}`)
  }
  window.console.warn = (...msgs) => {
    warn(...msgs)
    const msg = msgs.map(m => typeof m == 'string' ? m : JSON.stringify(m)).join(' ')
    const time = new Date().toLocaleString()
    if (tempLog) {
      tempLog({ type: 'WARN', time, text: msg })
    } else writeLog(`${time} WARN ${msg}`)
  }

  const init = async() => {
    try {
      let result = await requestStoragePermission()
      if (!result) return
      let isExists = await existsFile(logPath)
      console.log(logPath, isExists)
      if (!isExists) await writeFile(logPath, '')
      writeLog(tempLog(m => `${m.time} ${m.type} ${m.text}`).join('\n'))
      tempLog = null
    } catch (err) {
      console.error(err)
    }
  }


  init()
}

 */
