import { existsFile } from '@/utils/fs'
import {
  getWebDAVMusicDir,
  getWebDAVLrcDir,
  joinWebDAVRemotePath,
} from './client'
import { getStat, uploadBinaryFile } from './files'

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
  /** 进度回调（当前为文件粒度：完成时一次性置满） */
  onProgress?: (loaded: number, total: number) => void
}

/**
 * 带进度的单文件 PUT。
 *
 * 2026-10-05 安全修复：XHR+Blob 传输在真机上未经验证，且与原生崩溃
 * （-[__NSPlaceholderDictionary initWithObjects:forKeys:count:] attempt to insert nil）
 * 高度相关，已默认关闭。当前使用 webdav 库 PUT（已验证可完成），进度为文件粒度；
 * 字节级进度待真机验证 XHR+Blob 安全性后再启用。
 *
 * 用户暂停/删除导致的 abort 以 UploadAbortedError 抛出，调用方据此置 paused/cancelled，
 * 不计为失败。
 */
export const putFileWithProgress = async(options: PutFileOptions): Promise<void> => {
  const { remotePath, localPath, size, contentType, onProgress } = options
  const report = (loaded: number, total: number) => {
    try {
      onProgress?.(loaded, total)
    } catch {
      // 进度回调永不打断上传
    }
  }

  // webdav 库 PUT（无字节级进度，完成后一次性置满）
  await uploadBinaryFile(remotePath, localPath, contentType)
  report(size, size)

  // 成功后校验远端大小：2xx 不代表字节无损（如代理截断）；服务器不返回大小时放行
  const ok = await verifyRemoteSize(remotePath, size)
  if (!ok) {
    throw new Error('上传后校验失败：服务器文件大小与本地不一致')
  }
}
