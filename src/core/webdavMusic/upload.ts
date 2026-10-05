import { Buffer } from 'buffer'
import { readFile, existsFile } from '@/utils/fs'
import {
  getWebDAVRemoteUrl,
  getWebDAVAuthHeaders,
  getWebDAVMusicDir,
  getWebDAVLrcDir,
  joinWebDAVRemotePath,
} from './client'
import { getStat, uploadBinaryFile } from './files'
import { webDAVLog } from './logger'

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

// ---------------------------------------------------------------------------
// 传输层：XHR + Blob（真实字节进度），失败时回退到 webdav 库 PUT
// ---------------------------------------------------------------------------

export interface XhrUploadHandle {
  promise: Promise<number>
  abort: () => void
}

const XHR_TIMEOUT_MS = 10 * 60 * 1000
/** 进度停滞超过该时长视为卡死（上传回调里由调用方做看门狗，这里只暴露时间戳） */
export const UPLOAD_STALL_MS = 90 * 1000

/**
 * 用 XMLHttpRequest 做 WebDAV PUT，支持真实上传进度。
 * RN 的 XHR 由原生网络栈实现，upload.onprogress 可用；body 用 Blob 包
 * ArrayBuffer，避免整文件 base64 字符串常驻内存。
 * 返回 { promise<statusCode>, abort }；abort 后 promise 以 UploadAbortedError reject。
 */
const xhrPutFile = (
  url: string,
  localPath: string,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
): XhrUploadHandle => {
  let xhr: XMLHttpRequest | null = null
  let settled = false
  const settleReject = (reject: (e: any) => void, err: any) => {
    if (!settled) {
      settled = true
      reject(err)
    }
  }

  const promise = new Promise<number>((resolve, reject) => {
    const run = async() => {
      try {
        const base64 = await readFile(localPath, 'base64')
        if (!base64) throw new Error(`本地文件读取失败：${localPath}`)
        const buffer = Buffer.from(base64, 'base64')
        // 尽早释放 base64 大字符串，后续只用 ArrayBuffer
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        let blob: Blob
        try {
          blob = new Blob([arrayBuffer], { type: headers['Content-Type'] || 'application/octet-stream' })
        } catch (err: any) {
          throw new Error(`BLOB_NOT_SUPPORTED:${err?.message ?? err}`)
        }

        xhr = new XMLHttpRequest()
        xhr.open('PUT', url)
        for (const key of Object.keys(headers)) {
          try {
            xhr.setRequestHeader(key, headers[key])
          } catch {
            // 某些头（如 Content-Length）不允许手动设置，忽略
          }
        }
        xhr.timeout = XHR_TIMEOUT_MS
        const up: any = (xhr as any).upload
        if (up) {
          up.onprogress = (e: any) => {
            if (e && e.lengthComputable && e.total > 0) {
              onProgress(e.loaded, e.total)
            }
          }
        } else {
          throw new Error('UPLOAD_PROGRESS_NOT_SUPPORTED')
        }
        xhr.onload = () => {
          if (settled) return
          settled = true
          resolve(xhr?.status ?? 0)
        }
        xhr.onerror = () => { settleReject(reject, new Error('网络错误，上传中断')) }
        xhr.ontimeout = () => { settleReject(reject, new Error('上传超时（10 分钟无响应）')) }
        xhr.onabort = () => { settleReject(reject, new UploadAbortedError()) }
        xhr.send(blob as any)
      } catch (err) {
        settleReject(reject, err)
      }
    }
    void run()
  })

  return {
    promise,
    abort: () => {
      try {
        xhr?.abort()
      } catch {
        // ignore
      }
    },
  }
}

/** 上传后校验远端文件大小，防止静默损坏。
 * 返回 true = 一致或无法确定（服务器未返回大小时放行，避免误杀）；
 * 返回 false = 明确不一致。 */
const verifyRemoteSize = async(remotePath: string, expectedSize: number): Promise<boolean> => {
  try {
    const st: any = await getStat(remotePath)
    const remoteSize = typeof st?.size === 'number' ? st.size : Number(st?.size ?? -1)
    if (!(remoteSize >= 0)) return true
    return remoteSize === expectedSize
  } catch {
    return true
  }
}

export interface PutFileOptions {
  remotePath: string
  localPath: string
  size: number
  contentType?: string
  /** 字节进度回调 */
  onProgress?: (loaded: number, total: number) => void
  /** 外部取消信号：调用方暂停/删除时 abort */
  onAbortHandle?: (handle: { abort: () => void }) => void
}

/**
 * 带真实进度的单文件 PUT。
 * 1. 首选 XHR + Blob（upload.onprogress 给出真实字节进度）；
 * 2. XHR 传输层不可用（Blob/进度不支持）时回退 webdav 库 PUT；
 * 3. 每次成功后都校验远端大小，不一致则抛错（由调用方决定是否重试）。
 * 用户暂停/删除导致的 abort 以 UploadAbortedError 抛出，调用方据此置 paused/cancelled，
 * 不计为失败。
 */
export const putFileWithProgress = async(options: PutFileOptions): Promise<void> => {
  const { remotePath, localPath, size, contentType, onProgress, onAbortHandle } = options
  const url = getWebDAVRemoteUrl(remotePath)
  const headers: Record<string, string> = {
    ...getWebDAVAuthHeaders(),
    ...(contentType ? { 'Content-Type': contentType } : {}),
  }
  const report = (loaded: number, total: number) => {
    try {
      onProgress?.(loaded, total)
    } catch {
      // 进度回调永不打断上传
    }
  }

  let usedFallback = false
  try {
    const handle = xhrPutFile(url, localPath, headers, report)
    onAbortHandle?.(handle)
    const status = await handle.promise
    if (status < 200 || status >= 300) {
      throw new Error(`服务器返回 ${status}`)
    }
  } catch (err: any) {
    if (err instanceof UploadAbortedError) throw err
    const msg = String(err?.message ?? err)
    const transportUnsupported = msg.includes('BLOB_NOT_SUPPORTED') || msg.includes('UPLOAD_PROGRESS_NOT_SUPPORTED')
    if (!transportUnsupported) throw err
    // 传输层不支持，回退到 webdav 库 PUT（无字节进度，完成后一次性置满）
    webDAVLog.warn('[upload] XHR 传输不可用，回退 webdav 库', { remotePath, reason: msg })
    usedFallback = true
    await uploadBinaryFile(remotePath, localPath, contentType)
    report(size, size)
  }

  // 成功后必须校验远端大小：XHR 2xx 不代表字节无损（如代理截断）
  const ok = await verifyRemoteSize(remotePath, size)
  if (!ok) {
    if (!usedFallback) {
      webDAVLog.warn('[upload] 大小校验不一致，尝试 webdav 库重传', { remotePath, size })
      await uploadBinaryFile(remotePath, localPath, contentType)
      report(size, size)
      const ok2 = await verifyRemoteSize(remotePath, size)
      if (!ok2) throw new Error('上传后校验失败：服务器文件大小与本地不一致')
      return
    }
    throw new Error('上传后校验失败：服务器文件大小与本地不一致')
  }
}
