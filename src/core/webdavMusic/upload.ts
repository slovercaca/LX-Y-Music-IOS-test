import { Buffer } from 'buffer'
import { existsFile, stat as statFile, readFile } from '@/utils/fs'
import {
  getWebDAVMusicDir,
  getWebDAVLrcDir,
  getWebDAVRemoteUrl,
  getWebDAVAuthHeaders,
  joinWebDAVRemotePath,
  getClient,
} from './client'
import { getStat } from './files'
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

  // Fire 重写 v2：弃用 XHR+Blob（桥接 nil 崩溃无法根治），也弃用 RNFS.uploadFiles
  //（multipart/form-data，不适合 WebDAV raw PUT）。
  // 改用 webdav 库的 putFileContents：走 JS 层 HTTP，可靠不崩溃。
  // 代价：无原生字节级进度，用"读取进度+上传中"两阶段模拟；大文件会占内存（base64 1.37x）。
  // 优先级：不崩溃 > 真实进度。

  // 校验本地文件存在且非空
  const stat = await statFile(localPath).catch(() => null)
  if (!stat || stat.isDirectory?.()) throw new Error(`本地文件读取失败：${localPath}`)
  const actualSize = Number((stat as any).size ?? 0)
  if (!Number.isFinite(actualSize) || actualSize <= 0) throw new Error(`本地文件为空：${localPath}`)
  if (actualSize !== size) {
    webDAVLog.warn('[upload] 文件大小与入队时不一致', { remotePath, expected: size, actual: actualSize })
  }

  const url = getWebDAVRemoteUrl(remotePath)
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`上传地址非法：${url}`)
  }

  // 读文件为 Buffer（webdav 库需要）
  // 注意：大文件会占内存，这是为可靠性的妥协
  report(0, actualSize)
  const base64 = await readFile(localPath, 'base64').catch(() => '')
  if (!base64) throw new Error(`本地文件读取失败：${localPath}`)
  report(actualSize * 0.5, actualSize) // 读取完成，50%

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) throw new Error(`本地文件为空：${localPath}`)

  // abort 支持：webdav 库的 putFileContents 不支持中断，用标志位模拟
  //（实际无法中断原生请求，但可阻止后续流程）
  let abortRequested = false
  try {
    onAbortHandle?.({
      abort: () => {
        abortRequested = true
        // webdav 库无中断 API，只能标记，等待 put 完成或超时
      },
    })
  } catch {
    // 忽略
  }

  if (abortRequested) throw new UploadAbortedError()

  // 用 webdav 库上传（JS 层，无原生桥接崩溃风险）
  const client = getClient()
  try {
    // putFileContents 的 data 支持 Buffer
    await client.putFileContents(remotePath, buffer as any, {
      overwrite: true,
      contentLength: buffer.length,
    })
  } catch (e: any) {
    if (abortRequested) throw new UploadAbortedError()
    throw new Error(`上传失败：${e?.message || e}`)
  }

  if (abortRequested) throw new UploadAbortedError()
  report(actualSize, actualSize)

  // 成功后校验远端大小
  const ok = await verifyRemoteSize(remotePath, buffer.length)
  if (!ok) {
    throw new Error('上传后校验失败：服务器文件大小与本地不一致')
  }
}
