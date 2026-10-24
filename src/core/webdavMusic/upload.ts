import { Buffer } from 'buffer'
import { NativeModules, NativeEventEmitter } from 'react-native'
import { existsFile, stat as statFile, readFile } from '@/utils/fs'
import settingState from '@/store/setting/state'
import {
  getWebDAVMusicDir,
  getWebDAVLrcDir,
  getWebDAVPictureDir,
  getWebDAVRemoteUrl,
  getWebDAVAuthHeaders,
  joinWebDAVRemotePath,
  getClient,
} from './client'
import { getStat } from './files'
import { webDAVLog } from './logger'

// 原生上传模块（iOS）：URLSession 流式上传，真实进度、可中断、低内存。
// 不可用时（旧包/Android）降级到 webdav 库。
const NativeUpload = (NativeModules as any)?.WebDAVUploadModule ?? null
let nativeEmitter: NativeEventEmitter | null = null
const getNativeEmitter = (): NativeEventEmitter | null => {
  if (!NativeUpload) return null
  if (!nativeEmitter) {
    try {
      nativeEmitter = new NativeEventEmitter(NativeUpload)
    } catch {
      return null
    }
  }
  return nativeEmitter
}

/** 用原生模块上传（流式、真实进度、可中断） */
const putViaNative = async(
  url: string,
  localPath: string,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
  onAbortHandle: PutFileOptions['onAbortHandle'],
  /** 分块/断点续传：指定字节范围 [startOffset, endOffset)，totalSize 为文件总大小 */
  range?: { startOffset: number; endOffset: number; totalSize: number },
): Promise<number> => {
  const uploadId = `wdu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const emitter = getNativeEmitter()
  let abortRequested = false

  // 分块时调整进度回调：native 上报的是块内进度，需映射到全局
  const baseOffset = range?.startOffset ?? 0
  const sub = emitter?.addListener('WebDAVUploadProgress', (e: any) => {
    if (e?.uploadId !== uploadId) return
    try {
      const chunkSent = Number(e.totalBytesSent) || 0
      const chunkTotal = Number(e.totalBytesExpectedToSend) || 0
      // 映射到全局：baseOffset + chunkSent
      onProgress(baseOffset + chunkSent, range?.totalSize ?? chunkTotal)
    } catch { /* 忽略 */ }
  })

  // 透出 abort 句柄
  try {
    onAbortHandle?.({
      abort: () => {
        abortRequested = true
        try {
          NativeUpload.cancelUpload(uploadId)
        } catch { /* 忽略 */ }
      },
    })
  } catch { /* 忽略 */ }

  // 分块时加 Content-Range 头
  const finalHeaders = { ...headers }
  const options: Record<string, any> = {
    url,
    filePath: localPath,
    headers: finalHeaders,
    method: 'PUT',
    uploadId,
  }
  if (range) {
    // Content-Range: bytes <start>-<end>/<total>（end 为闭区间）
    finalHeaders['Content-Range'] = `bytes ${range.startOffset}-${range.endOffset - 1}/${range.totalSize}`
    options.startOffset = range.startOffset
    options.endOffset = range.endOffset
  }

  try {
    // 单字典传参（避免多参数桥接越界）
    const result: any = await NativeUpload.uploadFile(options)
    return Number(result?.statusCode ?? 0)
  } catch (e: any) {
    // 原生取消 -> 转为 UploadAbortedError
    if (abortRequested || e?.code === 'E_CANCELLED') {
      throw new UploadAbortedError()
    }
    // 中-3：原生对非 2xx 是 reject（code = E_HTTP_<状态码>），而本函数契约与
    // 调用方的 409 建目录、Content-Range 不支持降级等判断都按「拿到 statusCode」
    // 设计。把状态码还原成返回值，那些分支才活；否则全是死代码，且 409 时会
    // 先白白失败一次、再降级整文件 base64 读内存重传。
    const httpMatch = /E_HTTP_(\d+)/.exec(String(e?.code ?? ''))
    if (httpMatch) return Number(httpMatch[1])
    throw e
  } finally {
    try { sub?.remove() } catch { /* 忽略 */ }
  }
}

/** 获取远端文件大小（断点续传用）。不存在返回 0，异常返回 -1 */
const getRemoteFileSize = async(remotePath: string): Promise<number> => {
  try {
    const stat: any = await getStat(remotePath)
    if (!stat) return 0
    const size = Number(stat.size)
    return Number.isFinite(size) && size >= 0 ? size : 0
  } catch {
    return 0
  }
}

/**
 * 上传后校验远端文件大小：PROPFIND 取远端 size，与本地比对。
 * 全量修复：stat 失败或不返回大小时不再静默放行/误报失败二选一——
 * 记一条明确的 warn（校验不可用），按成功处理，因为 DELETE-before-PUT
 * 已先行清掉旧文件，截断风险已大幅降低；真正能比大小时必须精确相等。
 * 404（文件确实没落盘）仍返回 false。
 */
const verifyRemoteSize = async(remotePath: string, expectedSize: number): Promise<boolean> => {
  try {
    const stat: any = await getStat(remotePath)
    if (!stat) return false
    const remoteSize = Number(stat.size)
    if (!Number.isFinite(remoteSize) || remoteSize < 0) {
      webDAVLog.warn('[upload] 远端未返回有效大小，大小校验跳过', { remotePath, expectedSize })
      return true
    }
    return remoteSize === expectedSize
  } catch (e: any) {
    webDAVLog.warn('[upload] 校验远端大小失败（stat 异常），按成功处理', { remotePath, error: e?.message ?? e })
    return true
  }
}

/**
 * 全量修复：队列上传的先 DELETE 再 PUT。
 * 与 files.ts 同理，PUT 不截断的服务器上小文件盖大文件会留尾巴。
 * 404 忽略；其他失败直接中止本次上传，保住旧文件，绝不继续 PUT 腐蚀它。
 */
const deleteRemoteFileOrAbort = async(remotePath: string): Promise<void> => {
  try {
    await getClient().deleteFile(remotePath)
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status
    if (status === 404) return
    // 复查修复：DELETE 409 可能是父目录不存在（部分服务器对缺失父目录
    // 的 DELETE 报 409 而不是 404），不能当成“删除失败中止”——否则
    // 原有的“409 问用户是否自动建目录再重试”流程永远走不到。
    // 409 转成 RemoteDirNotFoundError，让上传管理器按原流程处理。
    if (status === 409) {
      const lastSlash = remotePath.lastIndexOf('/')
      const dirPath = lastSlash > 0 ? remotePath.substring(0, lastSlash) : '/'
      throw new RemoteDirNotFoundError(dirPath)
    }
    const err = new Error(`上传前删除远端旧文件失败，上传已中止以保住旧文件：${remotePath}`)
    webDAVLog.error('[upload] 先 DELETE 旧远端文件失败，中止上传', { remotePath, error: error?.message ?? error })
    throw err
  }
}

/**
 * 全量修复：同远端路径上传串行锁。
 * 队列默认 2 并发，两个不同文件算出同一远端路径时，分块会交错混写、
 * 大小恰好相等时校验还会全部通过。同一路径的上传必须串行，后到的
 * 等先到的结算完再传，最终是后写者胜出，而不是混合体。
 */
const inFlightUploads = new Map<string, Promise<void>>()
const withUploadPathLock = async<T>(remotePath: string, fn: () => Promise<T>): Promise<T> => {
  while (inFlightUploads.has(remotePath)) {
    await inFlightUploads.get(remotePath)!.catch(() => {})
  }
  let release!: () => void
  const lock = new Promise<void>(resolve => { release = resolve })
  inFlightUploads.set(remotePath, lock)
  try {
    return await fn()
  } finally {
    if (inFlightUploads.get(remotePath) === lock) inFlightUploads.delete(remotePath)
    release()
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
export type WebDAVUploadKind = 'audio' | 'lrc' | 'picture'

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
  /** 上传阶段（用于详细状态显示） */
  phase?: string
  /** 阶段详情（如卡顿时长） */
  phaseDetail?: string
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

/** 远端父目录不存在（409）时抛出的错误，调用方可提示用户是否自动创建 */
export class RemoteDirNotFoundError extends Error {
  /** 缺失的远端目录路径 */
  dirPath: string
  constructor(dirPath: string, message?: string) {
    super(message || `远端目录不存在：${dirPath}`)
    this.name = 'RemoteDirNotFoundError'
    this.dirPath = dirPath
  }
}

// ---------------------------------------------------------------------------
// 远端路径：本地文件结构 → 服务器 music/ 与 lrc/ 目录语义
// ---------------------------------------------------------------------------

/**
 * 按文件种类计算远端完整路径（上传队列在入队时即算好，UI 可直接展示）：
 * - audio   → getWebDAVMusicDir(targetDir)/fileName
 * - lrc     → getWebDAVLrcDir(targetDir)/fileName（音频目录的兄弟 lrc/）
 * - picture → getWebDAVPictureDir(targetDir)/fileName（音频目录的兄弟 picture/，2026-10-13）
 */
export const buildUploadRemotePath = (
  uploadTargetDir: string,
  fileName: string,
  kind: WebDAVUploadKind,
): string => {
  const dir = kind === 'lrc'
    ? getWebDAVLrcDir(uploadTargetDir)
    : kind === 'picture'
      ? getWebDAVPictureDir(uploadTargetDir)
      : getWebDAVMusicDir(uploadTargetDir)
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

/**
 * 为本地音频查找同名封面（本地文件结构 music/、picture/ 与 lrc/ 兼容，2026-10-13）：
 * 1. 音频同目录 `<dir>/<base>.<picExt>`
 * 2. 音频目录的 picture/ 子目录 `<dir>/picture/<base>.<picExt>`
 * 3. 父目录的 picture/ `<parent>/picture/<base>.<picExt>`（下载目录结构：music/ 与 picture/ 并列）
 * 找不到返回 null。
 */
const PIC_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif', 'avif']
export const findLocalCoverFile = async(audioLocalPath: string, baseName: string): Promise<string | null> => {
  const localDir = audioLocalPath.substring(0, audioLocalPath.lastIndexOf('/'))
  const parentDir = localDir.substring(0, localDir.lastIndexOf('/'))
  const dirs = [localDir, `${localDir}/picture`, `${parentDir}/picture`]
  for (const dir of dirs) {
    for (const ext of PIC_EXTS) {
      const p = `${dir}/${baseName}.${ext}`
      if (await existsFile(p).catch(() => false)) return p
      // 大小写变体（如 .JPG）
      const pUpper = `${dir}/${baseName}.${ext.toUpperCase()}`
      if (pUpper !== p && await existsFile(pUpper).catch(() => false)) return pUpper
    }
  }
  return null
}

export interface PutFileOptions {
  remotePath: string
  localPath: string
  size: number
  contentType?: string
  /** 进度回调（当前为模拟进度：0% → 50% → 100%，非真实字节） */
  onProgress?: (loaded: number, total: number) => void
  /** 用户已明确选择「覆盖」远端同名文件时为 true：禁用按大小断点续传，从头传（W1） */
  forceFresh?: boolean
  /** 传输方式说明（如降级到无实时进度的通道时通知 UI 如实展示，W6） */
  onPhaseNote?: (note: string) => void
  /** 透出 abort 句柄，调用方（暂停/删除）可中断传输（模拟中断） */
  onAbortHandle?: (handle: { abort: () => void }) => void
}

/**
 * 单文件 PUT（webdav 库）。
 *
 * 2026-10-05 Fire 重写：弃用 XHR+Blob。RN 0.73 iOS 的 XHR 桥接层频繁触发
 * `-[__NSPlaceholderDictionary initWithObjects:forKeys:count:]` nil 崩溃，
 * JS 层无法根治。改用 webdav 库的 putFileContents（纯 JS HTTP），可靠不崩溃。
 *
 * 代价：
 * 1. 无原生字节级进度：用"0% → 50%（读取完成）→ 心跳保活 → 100%"模拟；
 * 2. 大文件内存占用高（base64 1.37x + Buffer 1x）；
 * 3. 中断为模拟（库无 abort API），网络请求后台继续，但 UI 状态正确。
 *
 * 优先级：不崩溃 > 真实进度。
 *
 * 用户暂停/删除导致的 abort 以 UploadAbortedError 抛出，调用方据此置 paused/cancelled，
 * 不计为失败。
 */
const putFileWithProgressInternal = async(options: PutFileOptions): Promise<void> => {
  const { remotePath, localPath, size, onProgress, onAbortHandle, forceFresh, onPhaseNote } = options
  // 注意：contentType 不再使用（webdav 库自动处理）；保留在接口中以兼容调用方
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
  if (!stat || stat.isDirectory) throw new Error(`本地文件读取失败：${localPath}`)
  const actualSize = Number((stat as any).size ?? 0)
  if (!Number.isFinite(actualSize) || actualSize <= 0) throw new Error(`本地文件为空：${localPath}`)
  if (actualSize !== size) {
    webDAVLog.warn('[upload] 文件大小与入队时不一致', { remotePath, expected: size, actual: actualSize })
  }

  // URL 合法性校验
  const url = getWebDAVRemoteUrl(remotePath)
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`上传地址非法：${url}`)
  }

  // 全量修复：先 DELETE 再 PUT，防 PUT 不截断留尾巴。DELETE 失败直接
  // 中止（见 deleteRemoteFileOrAbort），不腐蚀旧文件。分块上传的第一块
  // 从 0 开始写，删掉旧文件不影响分块创建语义；原生失败降级到 webdav
  // 库前还会再删一次，清掉可能已写了一半的分块文件。
  await deleteRemoteFileOrAbort(remotePath)

  // Test-v2：优先用原生模块（流式、真实进度、可中断、低内存）。
  // 不可用时降级到 webdav 库。
  if (NativeUpload) {
    try {
      // 构造请求头
      const authHeaders = getWebDAVAuthHeaders()
      const headers: Record<string, string> = {}
      for (const key of Object.keys(authHeaders)) {
        const v = (authHeaders as Record<string, unknown>)[key]
        if (v !== undefined && v !== null && v !== '') headers[key] = String(v)
      }

      // 读取分块/断点续传设置
      // W1：用户明确选了「覆盖」时禁用续传——只凭远端大小续传/判完整，可能把
      // 同大小不同内容当成功、或把新文件尾巴拼到旧文件头上生成损坏文件
      const resumeEnabled = !forceFresh && settingState.setting['webdav.uploadResume'] !== false
      const chunkedEnabled = settingState.setting['webdav.uploadChunked'] !== false
      const chunkSizeMB = Number(settingState.setting['webdav.uploadChunkSizeMB'] ?? 5)
      const chunkSize = Math.max(1, Math.min(100, chunkSizeMB)) * 1024 * 1024

      // 断点续传检查（高危修复）：此前只凭远端大小就①拼尾巴续传
      // ②>= 本地直接报成功——远端同名异内容时拼出「旧头+新尾」混合文件
      // 且总大小恰对、verifyRemoteSize 只比大小也放行，用户拿到损坏
      // 歌曲还显示成功；同名异内容整文件则假成功、错文件留在服务器。
      // 无法验证远端残片/现存文件与本地的内容同一性时，一律从 0 重传/
      // 覆盖。代价：uploadResume 的跨会话续传停用（同一会话内分块不受
      // 影响）；换取上传结果可信。
      let startOffset = 0
      if (resumeEnabled) {
        const remoteSize = await getRemoteFileSize(remotePath)
        if (remoteSize > 0 && remoteSize < actualSize) {
          webDAVLog.warn('[upload] 远端存在残片，无法验证同一性，从头重传', { remotePath, remoteSize, actualSize })
        } else if (remoteSize >= actualSize && remoteSize > 0) {
          webDAVLog.warn('[upload] 远端已存在同名文件，无法验证内容同一性，从头覆盖', { remotePath, remoteSize, actualSize })
        }
      }

      // 分块上传：文件大于块大小且启用分块时
      if (chunkedEnabled && actualSize > chunkSize) {
        webDAVLog.info('[upload] 分块上传', {
          remotePath,
          actualSize,
          chunkSize,
          startOffset,
          chunkCount: Math.ceil((actualSize - startOffset) / chunkSize),
        })
        let uploaded = startOffset
        report(uploaded, actualSize)
        let chunkUnsupported = false
        // 逐块上传（串行，WebDAV 不支持并行写同一文件）
        for (let offset = startOffset; offset < actualSize; offset += chunkSize) {
          const endOffset = Math.min(offset + chunkSize, actualSize)
          const statusCode = await putViaNative(
            url,
            localPath,
            headers,
            (loaded, total) => {
              // loaded 是全局偏移（putViaNative 已映射）
              report(loaded, total)
            },
            onAbortHandle,
            { startOffset: offset, endOffset, totalSize: actualSize },
          )
          if (statusCode === 409) {
            const lastSlash = remotePath.lastIndexOf('/')
            const dirPath = lastSlash > 0 ? remotePath.substring(0, lastSlash) : '/'
            throw new RemoteDirNotFoundError(dirPath)
          }
          // 服务器不支持 Content-Range（400/411/416/501）：第一块就失败时降级为整文件上传
          if ([400, 411, 416, 501].includes(statusCode) && offset === startOffset) {
            webDAVLog.warn('[upload] 服务器不支持 Content-Range，降级为整文件上传', { remotePath, statusCode })
            chunkUnsupported = true
            break
          }
          if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`分块上传失败（块 ${offset}-${endOffset}，HTTP ${statusCode}）`)
          }
          uploaded = endOffset
          report(uploaded, actualSize)
        }
        // 若因服务器不支持而跳出分块，则走整文件上传（不 return，继续向下）
        if (!chunkUnsupported) {
          // 成功后校验远端大小
          const ok = await verifyRemoteSize(remotePath, actualSize)
          if (!ok) throw new Error('上传后校验失败：服务器文件大小与本地不一致')
          return
        }
        webDAVLog.info('[upload] 分块不受支持，转整文件上传', { remotePath })
        // 重置进度，且清除断点偏移（服务器不支持 Content-Range，必须从头传）
        startOffset = 0
        report(0, actualSize)
      }

      // 非分块：单 PUT（支持断点续传的 Content-Range）
      // 注意：若上面分块因服务器不支持而降级，startOffset 已被清零，此处为整文件上传
      report(startOffset, actualSize)
      const range = startOffset > 0
        ? { startOffset, endOffset: actualSize, totalSize: actualSize }
        : undefined
      const statusCode = await putViaNative(url, localPath, headers, report, onAbortHandle, range)
      if (statusCode >= 200 && statusCode < 300) {
        report(actualSize, actualSize)
      } else if (statusCode === 409) {
        const lastSlash = remotePath.lastIndexOf('/')
        const dirPath = lastSlash > 0 ? remotePath.substring(0, lastSlash) : '/'
        throw new RemoteDirNotFoundError(dirPath)
      } else {
        throw new Error(`上传失败（HTTP ${statusCode}）`)
      }
      // 成功后校验远端大小
      const ok = await verifyRemoteSize(remotePath, actualSize)
      if (!ok) throw new Error('上传后校验失败：服务器文件大小与本地不一致')
      return
    } catch (e: any) {
      // 用户取消直接抛出；其他错误降级到 webdav 库重试
      if (e instanceof UploadAbortedError || e instanceof RemoteDirNotFoundError) throw e
      webDAVLog.warn('[upload] 原生上传失败，降级到 webdav 库', {
        error: e?.message ?? e,
        // 脱敏 URL（去掉用户名密码），方便定位连的是内网还是外网地址
        url: url.replace(/:\/\/[^@/]*@/, '://***@').split('?')[0],
        code: (e as any)?.code,
      })
    }
  }

  // 降级：webdav 库（JS 层，无原生桥接崩溃风险，但无真实进度、大内存）
  // 读文件为 Buffer（webdav 库需要）
  report(0, actualSize)
  const base64 = await readFile(localPath, 'base64').catch(() => '')
  if (!base64) throw new Error(`本地文件读取失败：${localPath}`)
  // W6：不再把「读完文件」伪装成上传 50%——该通道没有真实进度，如实告知 UI；
  // 进度保持 0 直到传输真正完成（report 100% 在 put 成功后）
  try {
    onPhaseNote?.('服务器通道无实时进度，正在传输…')
  } catch { /* 忽略 */ }

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

  // 全量修复：降级前再删一次——原生分块可能已写了一半文件，直接整文件
  // PUT 在不截断服务器上会留尾巴；删干净再整文件写才是对的。
  await deleteRemoteFileOrAbort(remotePath)

  // 用 webdav 库上传（JS 层，无原生桥接崩溃风险）
  const client = getClient()

  // 心跳保活：webdav 库无进度回调，上传期间每 10s 重复上报最后真实进度（0），
  // 只为刷新 useUploadManager 看门狗的活跃时间，不伪造百分比（W6）。
  // P0-1（2026-10-06）：此前 30s 心跳 > 15s 看门狗，大文件走降级必被误杀。
  const heartbeat = setInterval(() => {
    try {
      report(0, actualSize)
    } catch { /* 忽略 */ }
  }, 10000)

  try {
    // 全量修复：降级 PUT 加 600 秒硬超时竞速。webdav 库无中断 API，
    // 心跳每 10 秒刷新看门狗会把挂起的 PUT 永久掩盖；600 秒后一定结算
    // 为失败，队列才能排空、用户才能重试（底层请求若仍在跑，下一次
    // DELETE+重传会以新文件覆盖它，大小校验是最后一道关）。
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        client.putFileContents(remotePath, buffer as any, {
          overwrite: true,
          contentLength: buffer.length,
        }) as Promise<unknown>,
        new Promise<never>((_, reject) => {
          fallbackTimer = setTimeout(() => reject(new Error(`上传超时（600秒无响应）：${remotePath}`)), 600000)
        }),
      ])
    } finally {
      if (fallbackTimer) clearTimeout(fallbackTimer)
    }
  } catch (e: any) {
    clearInterval(heartbeat)
    if (abortRequested) throw new UploadAbortedError()
    // 409：父目录不存在。抛专用错误，调用方提示用户是否自动创建。
    const status = e?.status ?? e?.response?.status
    if (status === 409) {
      const lastSlash = remotePath.lastIndexOf('/')
      const dirPath = lastSlash > 0 ? remotePath.substring(0, lastSlash) : '/'
      throw new RemoteDirNotFoundError(dirPath)
    }
    throw new Error(`上传失败：${e?.message || e}`)
  }
  clearInterval(heartbeat)

  if (abortRequested) throw new UploadAbortedError()
  report(actualSize, actualSize)

  // 成功后校验远端大小
  // P1-10（2026-10-06）：用 stat 得到的 actualSize 而非 buffer.length。
  // 文件在 stat 与 read 之间被修改时两者不一致，buffer.length 会导致误判。
  const ok = await verifyRemoteSize(remotePath, actualSize)
  if (!ok) {
    throw new Error('上传后校验失败：服务器文件大小与本地不一致')
  }
}

/**
 * 全量修复：队列上传对外入口（同路径串行 + 校验失败自愈重传）。
 * - 同远端路径的并发上传串行化，防分块混写（见 withUploadPathLock）。
 * - 大小校验失败时删掉已损坏的远端文件、整文件重传一次，再失败才
 *   明确报错；此前是直接失败、坏文件留在服务器上、重试也修不好。
 * - 取消（UploadAbortedError）与目录缺失（RemoteDirNotFoundError）不重传。
 */
export const putFileWithProgress = async(options: PutFileOptions): Promise<void> => {
  return withUploadPathLock(options.remotePath, async() => {
    try {
      await putFileWithProgressInternal(options)
    } catch (error: any) {
      if (error instanceof UploadAbortedError || error instanceof RemoteDirNotFoundError) throw error
      if (!String(error?.message ?? '').includes('上传后校验失败')) throw error
      webDAVLog.warn('[upload] 大小校验失败，删掉坏文件后重传一次', { remotePath: options.remotePath })
      try {
        await deleteRemoteFileOrAbort(options.remotePath)
      } catch (deleteError: any) {
        // 复查修复：重传前 DELETE 报 409（父目录缺失）时，原样透出
        // RemoteDirNotFoundError，让管理器走建目录流程，而不是用
        // 旧的校验失败错误把它盖掉。
        if (deleteError instanceof RemoteDirNotFoundError) throw deleteError
        throw error
      }
      await putFileWithProgressInternal(options)
    }
  })
}
