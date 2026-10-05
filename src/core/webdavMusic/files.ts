import { Buffer } from 'buffer'
import type { FileStat } from 'webdav'
import {
  downloadFile as rnDownloadFile,
  existsFile,
  moveFile,
  read,
  readFile,
  stat as statLocalFile,
  unlink,
} from '@/utils/fs'
import { getClient, getWebDAVAuthHeaders } from './client'
import { webDAVLog } from './logger'

/**
 * WebDAV 远端文件原语（重写版）。
 *
 * 职责：所有与服务器直接打交道的读写操作。调用方（library / sync）
 * 只用这里的函数，不再各自拼 webdav 库调用。
 *
 * 兼容承诺：
 * - uploadFile / downloadFile / getStat / uploadBinaryFile 与旧 utils/webdav.ts
 *   同名同签名，行为一致（404 → null、超时 2 分钟、分阶段回调）
 * - downloadToFileAtomic / checkWebDAVRemoteExists 与旧 drive.ts 同名同行为
 */

export interface RemoteEntry {
  /** webdav 库返回的 filename（可做唯一 id） */
  id: string
  name: string
  /** 以 / 开头的完整远端路径 */
  path: string
  type: 'file' | 'directory'
  size?: number
  lastmod?: string
}

const toEntry = (item: any, parentPath?: string): RemoteEntry => ({
  id: item.filename,
  name: item.basename,
  // P1-5：path 直接用服务器返回的 filename（权威值），而非 parentPath+basename 拼接。
  // 拼接在百分号编码差异、Unicode NFC/NFD 规范化差异（macOS/Linux NAS 常见）时
  // 会与服务器真实路径对不上，导致后续请求 404。
  path: item.filename || (parentPath ? `${parentPath}/${item.basename}` : `/${item.basename}`),
  type: item.type,
  size: item.size,
  lastmod: item.lastmod,
})

/** 列出目录内容；404/409（不存在/冲突）返回空数组，其余错误上抛 */
export const listRemoteEntries = async(dirPath: string): Promise<RemoteEntry[]> => {
  const client = getClient()
  let contents: any[]
  try {
    contents = (await client.getDirectoryContents(dirPath)) as any[]
  } catch (error: any) {
    webDAVLog.error('listRemoteEntries error', { dirPath, status: error?.status })
    if (error?.status === 404 || error?.status === 409) return []
    throw error
  }
  return contents.map(item => toEntry(item, dirPath === '/' ? '' : dirPath))
}

/** 只列子目录（供目录浏览用），按名称排序 */
export const listRemoteSubDirs = async(dirPath: string): Promise<LX.WebDAV.DriveFolder[]> => {
  const entries = await listRemoteEntries(dirPath)
  return entries
    .filter(e => e.type === 'directory')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<LX.WebDAV.DriveFolder>(e => ({
      id: e.id,
      name: e.name,
      path: e.path,
    }))
}

/**
 * 递归确保远端目录存在（逐级创建，跳过已存在的层级）。
 * 与旧 ensureDir 行为一致：分段 createDirectory，409/已存在继续。
 */
export const ensureRemoteDir = async(dirPath: string): Promise<void> => {
  const client = getClient()
  const segments = String(dirPath || '/').split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    try {
      await client.createDirectory(current)
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status
      // 405/409/412 通常表示已存在，继续下一级；其它错误上抛
      if (status === 405 || status === 409 || status === 412) continue
      // 兜底：用 stat 确认是否真的已存在
      if (await checkWebDAVRemoteExists(current).catch(() => false)) continue
      throw error
    }
  }
}

/** stat：存在返回 FileStat，不存在（404）返回 null（与旧 getStat 一致） */
export const getStat = async(remotePath: string): Promise<FileStat | null> => {
  try {
    return (await getClient().stat(remotePath)) as FileStat
  } catch (error: any) {
    if (error?.status === 404) return null
    throw error
  }
}

/** 检查远端路径是否存在（存在 true / 不存在 false） */
export const checkWebDAVRemoteExists = async(remotePath: string): Promise<boolean> => {
  return (await getStat(remotePath).catch(() => null)) != null
}

/**
 * 读远端文本文件；不存在（404/409）返回 null，其余错误上抛。
 * 同步流程用它读 playlists.json / settings.json / user_apis.json。
 */
export const downloadFile = async(remotePath: string): Promise<string | null> => {
  const client = getClient()
  try {
    const result: any = await client.getFileContents(remotePath, { format: 'text' })
    return typeof result === 'string' ? result : null
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 409) return null
    throw error
  }
}

/** 写远端文本文件（先确保父目录存在） */
export const uploadFile = async(remotePath: string, content: string): Promise<void> => {
  const client = getClient()
  const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/'
  await ensureRemoteDir(parent)
  await client.putFileContents(remotePath, content, { overwrite: true })
}

/**
 * 上传本地二进制文件（重写版，行为与旧版一致）：
 * - 先校验本地文件：stat 失败 / 是目录 / 大小为 0 直接抛错，
 *   不再把读失败吞成 size: 0 的无效上传
 * - 先确保远端父目录存在
 * - base64 → Buffer → putFileContents，超时 2 分钟
 * - onStage 分阶段回调（定位上传卡死用）
 */
export const uploadBinaryFile = async(
  remotePath: string,
  localPath: string,
  contentType?: string,
  onStage?: (stage: string) => void,
): Promise<void> => {
  const report = (stage: string) => {
    webDAVLog.info(`[upload] ${stage}`, { remotePath })
    onStage?.(stage)
  }

  report('正在校验本地文件…')
  // stat 精确校验：失败 / 是目录 / 大小为 0 直接抛错，
  // 不再把读失败吞成 size: 0 的无效上传
  const info = await statLocalFile(localPath).catch(() => null)
  if (!info || info.isDirectory || !info.size) {
    throw new Error(`本地文件不可读或为空：${localPath}`)
  }

  report('正在准备上传目录…')
  const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/'
  await ensureRemoteDir(parent)

  report('正在读取本地文件…')
  const base64 = await readFile(localPath, 'base64')
  if (!base64) throw new Error(`本地文件读取失败：${localPath}`)

  report('正在上传到服务器…')
  const client = getClient()
  const buffer = Buffer.from(base64, 'base64')
  await client.putFileContents(remotePath, buffer, {
    overwrite: true,
    ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
    // 大文件上传兜底：2 分钟超时
    timeout: 120000,
  } as any)
  report('上传完成')
}

/**
 * 兼容旧版本毒化缓存：此前下载未校验 statusCode，401/404 的错误页面
 * （XML/HTML，首字节必为 '<'）会被当成正常文件缓存。音频文件的首字节
 * 不可能是 '<'，命中则删掉并走正常下载流程；读不到首字节时保守地视为有效。
 */
export const isPoisonedCache = async(filePath: string): Promise<boolean> => {
  const head = await read(filePath, 1, 0, 'utf8').catch(() => '')
  return head === '<'
}

/**
 * 原子下载：先下载到唯一临时文件，statusCode/bytesWritten 校验通过后再改名到目标路径。
 * 解决两个问题：
 * 1) RNFS downloadFile 在 HTTP 错误（401/404 等）时 resolve（靠 statusCode 识别）、
 *    网络中断时 reject，两种失败都会在目标路径留下错误页面/截断文件；毒缓存检查
 *    （首字节 '<'）识别不出截断的音频/图片，下次 existsFile 直接命中坏文件、永久
 *    播不出。走临时文件可保证任何失败都不会污染目标路径。
 * 2) 预加载与播放可能并发下载同一文件，唯一临时文件名保证互不删除对方的文件；
 *    改名时若目标已存在（另一路已先落盘）则直接复用。
 */
export const downloadToFileAtomic = async(options: {
  url: string
  targetPath: string
  statusError: (statusCode: number) => string
  moveError: string
}): Promise<void> => {
  const { url, targetPath, statusError, moveError } = options
  const tmpPath = `${targetPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`
  const cleanupTmp = () => unlink(tmpPath).catch(() => {})
  try {
    // 诊断日志：404 排查用。记录完整 URL 和 headers（密码脱敏）。
    // 如果下载 404 但 PROPFIND 正常，对比两者差异定位问题。
    const headers = getWebDAVAuthHeaders()
    const safeHeaders: Record<string, string> = {}
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') {
        // 只显示认证类型和长度，不显示具体值
        const v = headers[k] || ''
        safeHeaders[k] = v.split(' ')[0] + ' <' + v.length + ' chars>'
      } else {
        safeHeaders[k] = headers[k]
      }
    }
    webDAVLog.info('downloadToFileAtomic: 开始下载', { url, headers: safeHeaders })
    const result = await rnDownloadFile(url, tmpPath, { headers }).promise
    if (result.statusCode < 200 || result.statusCode >= 300 || !result.bytesWritten) {
      webDAVLog.error('downloadToFileAtomic: 下载失败', {
        statusCode: result.statusCode,
        url,
        headers: safeHeaders,
        bytesWritten: result.bytesWritten,
        // 提示：如果 PROPFIND 能列出文件但 GET 404，
        // 可能是服务器对未认证请求返回 404（鉴权头有问题），
        // 或 URL 编码与服务器期望不一致。
      })
      throw new Error(statusError(result.statusCode))
    }
    try {
      await moveFile(tmpPath, targetPath)
    } catch {
      // 改名失败：大概率是并发下载的另一路已先落盘，复用它；否则如实抛错
      await cleanupTmp()
      if (await existsFile(targetPath)) {
        webDAVLog.info('downloadToFileAtomic: 并发下载已由另一路完成，复用缓存', { targetPath })
        return
      }
      throw new Error(moveError)
    }
  } catch (err) {
    await cleanupTmp()
    throw err
  }
}

