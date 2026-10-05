import { Buffer } from 'buffer'
import { existsFile } from '@/utils/fs'
import {
  getWebDAVMusicDir,
  getWebDAVLrcDir,
  getWebDAVRemoteUrl,
  getWebDAVAuthHeaders,
  joinWebDAVRemotePath,
} from './client'
import { getStat } from './files'
import { readFile } from '@/utils/fs'
import { webDAVLog } from '@/utils/log'

/**
 * 上传后校验远端文件大小：PROPFIND 取远端 size，与本地比对。
 * 服务器不返回大小时放行（避免误杀）；404/异常时返回 false。
 */
const verifyRemoteSize = async(remotePath: string, expectedSize: number): Promise<boolean> => {
  try {
    const stat: any = await getStat(remotePath)
    if (!stat) return false
    const remoteSize = Number(stat.size)
    // 服务器不返回有效大小时放行
    if (!Number.isFinite(remoteSize) || remoteSize < 0) return true
    return remoteSize === expectedSize
  } catch (e: any) {
    webDAVLog.warn('[upload] 校验远端大小失败', { remotePath, error: e?.message ?? e })
    return false
  }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 队列项状态：排队 / 上传中 / 已暂停 / 已完成 / 失败 / 已取消 */
export type WebDAVUploadStatus =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 队列项文件种类：音频进 music/，歌词进 lrc/（兄弟目录） */
export type WebDAVUploadKind = 'audio' | 'lrc'

export interface WebDAVUploadQueueItem {
  /** 本地唯一 id */
  id: string
  /** 本地文件完整路径 */
  localPath: string
  /** 文件名（含扩展名），即服务器上的文件名 */
  fileName: string
  /** 文件大小（字节） */
  size: number
  kind: WebDAVUploadKind
  /** 计算好的远端完整路径（audio → music/，lrc → lrc/） */
  remotePath: string
  /** 入队时的上传目标目录（展示用） */
  targetDir: string
  status: WebDAVUploadStatus
  /** 已上传字节（真实进度回调累计） */
  uploadedBytes: number
  /** 瞬时速度（字节/秒，指数滑动平均） */
  speed: number
  /** 最近一次进度回调的时间戳 */
  lastProgressAt: number
  /** 失败原因（status 为 failed 时） */
  error?: string
  /** 是否来自文件 App 临时复制（完成后删除） */
  isTempFile: boolean
  /** 加入队列的时间戳 */
  addedAt: number
  /** 取走次数（防 stale worker 重复结算） */
  attempt?: number
  /** 完成/失败的时间戳（历史用） */
  finishedAt?: number
}

export interface WebDAVUploadHistoryItem {
  id: string
  fileName: string
  size: number
  kind: WebDAVUploadKind
  remotePath: string
  status: 'completed' | 'failed'
  error?: string
  finishedAt: number
}

/** 队列整体状态：空闲 / 上传中 / 已暂停（显式状态机，不再靠零散 flag 推断） */
export type WebDAVUploadQueueState = 'idle' | 'uploading' | 'paused'

/** 用户主动取消（暂停/删除）时抛出的错误，用于和网络失败区分 */
export class UploadAbortedError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'UploadAbortedError'
  }
}

// ---------------------------------------------------------------------------
// 远端路径：本地文件结构 → 服务器 music/ 与 lrc/ 目录语义
// ---------------------------------------------------------------------------

/**
 * 按文件种类计算远端完整路径（上传队列在入队时即算好，UI 可直接展示）：
 * - audio → getWebDAVMusicDir(targetDir)/fileName
 * - lrc   → getWebDAVLrcDir(targetDir)/fileName（音频目录的兄弟 lrc/）
 */
export const buildUploadRemotePath = (
  uploadTargetDir: string,
  fileName: string,
  kind: WebDAVUploadKind,
): string => {
  const dir = kind === 'lrc' ? getWebDAVLrcDir(uploadTargetDir) : getWebDAVMusicDir(uploadTargetDir)
  return joinWebDAVRemotePath(dir, fileName)
}

/**
 * 为本地音频查找同名歌词（本地文件结构 music/ 与 lrc/ 兼容）：
 * 1. 音频同目录 `<dir>/<base>.lrc`
 * 2. 音频目录的 lrc/ 子目录 `<dir>/lrc/<base>.lrc`
 * 3. 父目录的 lrc/ `<parent>/lrc/<base>.lrc`（下载目录结构：music/ 与 lrc/ 并列）
 * 找不到返回 null。
 */
export const findLocalLyricFile = async(audioLocalPath: string, baseName: string): Promise<string | null> => {
  const lrcFileName = `${baseName}.lrc`
  const localDir = audioLocalPath.substring(0, audioLocalPath.lastIndexOf('/'))
  const parentDir = localDir.substring(0, localDir.lastIndexOf('/'))
  const candidates = [
    `${localDir}/${lrcFileName}`,
    `${localDir}/lrc/${lrcFileName}`,
    `${parentDir}/lrc/${lrcFileName}`,
  ]
  for (const p of candidates) {
    if (await existsFile(p).catch(() => false)) return p
  }
  return null
}

export interface PutFileOptions {
  remotePath: string
  localPath: string
  size: number
  contentType?: string
  /** 字节级进度回调（XHR upload.onprogress 真实字节） */
  onProgress?: (loaded: number, total: number) => void
  /** 透出 abort 句柄，调用方（暂停/删除）可中断传输 */
  onAbortHandle?: (handle: { abort: () => void }) => void
}

/**
 * 带真实字节级进度的单文件 PUT（XHR + Blob）。
 *
 * 2026-10-05 闪退修复：RN 桥接层 `-[__NSPlaceholderDictionary initWithObjects:forKeys:count:]`
 * 崩溃的根因是 `xhr.setRequestHeader(name, undefined)` —— JS 传 undefined 给原生模块，
 * 原生尝试创建 NSDictionary 时遇到 nil 直接崩。本实现：
 * 1. 所有 header 值先做 nil 过滤，undefined/null 一律不 set；
 * 2. Content-Type 仅在有值时设置；
 * 3. Blob 创建前校验数据非空；
 * 4. 进度回调 try/catch 包裹，永不打断上传。
 *
 * 用户暂停/删除导致的 abort 以 UploadAbortedError 抛出，调用方据此置 paused/cancelled，
 * 不计为失败。
 */
export const putFileWithProgress = async(options: PutFileOptions): Promise<void> => {
  const { remotePath, localPath, size, contentType, onProgress, onAbortHandle } = options
  const report = (loaded: number, total: number) => {
    try {
      onProgress?.(loaded, total)
    } catch {
      // 进度回调永不打断上传
    }
  }

  // 读本地文件为 base64，转 Buffer 再包 Blob（RN XHR send Blob 走原生上传，有真实进度）
  // 用 Buffer.from 而不用 atob+循环：大文件时 atob 会产生翻倍的中间内存
  const base64 = await readFile(localPath, 'base64').catch(() => '')
  if (!base64) throw new Error(`本地文件读取失败：${localPath}`)
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error(`本地文件为空：${localPath}`)
  if (buffer.length !== size) {
    webDAVLog.warn('[upload] 文件大小与入队时不一致', { remotePath, expected: size, actual: buffer.length })
  }

  const url = getWebDAVRemoteUrl(remotePath)
  const authHeaders = getWebDAVAuthHeaders()

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    // 透出 abort 句柄：暂停/删除时中断传输
    try {
      onAbortHandle?.({
        abort: () => {
          done(() => reject(new UploadAbortedError()))
          try { xhr.abort() } catch { /* 忽略 */ }
        },
      })
    } catch {
      // 句柄回调异常不影响上传本身
    }

    xhr.open('PUT', url, true)

    // ---- 闪退修复核心：header 值必须非空 ----
    // RN 的 setRequestHeader 最终走原生 NSDictionary，value 为 undefined/null 会直接崩溃。
    // 这里逐个检查，只 set 有值的 header。
    try {
      for (const key of Object.keys(authHeaders)) {
        const value = (authHeaders as Record<string, unknown>)[key]
        if (value !== undefined && value !== null && value !== '') {
          xhr.setRequestHeader(key, String(value))
        }
      }
      if (contentType !== undefined && contentType !== null && contentType !== '') {
        xhr.setRequestHeader('Content-Type', String(contentType))
      }
    } catch (e: any) {
      done(() => reject(new Error(`设置请求头失败：${e?.message || e}`)))
      return
    }

    // xhr.upload 在某些 RN 版本/环境下可能为 undefined，直接赋值会抛 TypeError
    // 且 Promise 永不结算（卡死）。先判空，有才挂进度回调。
    try {
      if (xhr.upload) {
        xhr.upload.onprogress = (e: any) => {
          try {
            if (e && e.lengthComputable) report(e.loaded, e.total)
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略：无进度事件不影响上传本身 */ }

    xhr.onload = () => {
      done(() => {
        const status = xhr.status || 0
        if (status >= 200 && status < 300) {
          report(buffer.length, buffer.length)
          resolve()
        } else {
          reject(new Error(`上传失败（HTTP ${status}）`))
        }
      })
    }
    xhr.onerror = () => done(() => reject(new Error('上传网络错误')))
    xhr.ontimeout = () => done(() => reject(new Error('上传超时')))
    xhr.onabort = () => done(() => reject(new UploadAbortedError()))
    // 大文件上传：10 分钟超时（webdav 库版本是 2 分钟，XHR 给更宽裕）
    xhr.timeout = 600000

    try {
      // 注意：RN 的 Blob polyfill 对 undefined options 处理不好，可能传 nil 给原生层导致崩溃。
      // contentType 为空时直接不传第二个参数。
      const blob = contentType
        ? new Blob([buffer as any], { type: contentType })
        : new Blob([buffer as any])
      xhr.send(blob as any)
    } catch (e: any) {
      done(() => reject(new Error(`创建上传数据失败：${e?.message || e}`)))
    }
  })

  // 成功后校验远端大小：用实际发送的字节数（buffer.length），而非入队时的 size
  //（P1-1：文件在入队后被修改时，size 是陈旧的，会导致误判失败死循环）
  const ok = await verifyRemoteSize(remotePath, buffer.length)
  if (!ok) {
    throw new Error('上传后校验失败：服务器文件大小与本地不一致')
  }
}
