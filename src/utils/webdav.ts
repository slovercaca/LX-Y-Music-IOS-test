import settingState from '@/store/setting/state'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { readFile, stat } from '@/utils/fs'
import { Buffer } from 'buffer'

import { createClient, type FileStat } from 'webdav'

let client: any = null

function getClient() {
  if (client) return client

  const settings = settingState.setting
  const url = settings['sync.webdav.url']
  const username = settings['sync.webdav.username']
  const password = settings['sync.webdav.password']

  if (!url || !username) {
    webDAVLog.warn('WebDAV 未配置: URL 或用户名为空')
    return null
  }

  // createClient imported at top
  client = createClient(url, { username, password })
  return client
}

/**
 * When WebDAV configuration changes, call this function to reset the client instance.
 */
export function resetClient() {
  client = null
}

export async function testConnection(): Promise<boolean> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')
  await cli.getDirectoryContents('/')
  return true
}

/**
 * Create directories step by step, compatible with servers that do not support recursive creation.
 * @param cli WebDAV client instance
 * @param dirPath directory path to create
 */
async function ensureDirectoryExists(cli: any, dirPath: string): Promise<void> {
  if (!dirPath || dirPath === '/') return

  const segments = dirPath.split('/').filter(Boolean)
  let currentPath = ''

  for (const segment of segments) {
    currentPath += `/${segment}`
    try {
      if (!(await cli.exists(currentPath))) {
        webDAVLog.info(`Directory ${currentPath} not found, creating it...`)
        await cli.createDirectory(currentPath)
      }
    } catch (error: any) {
      throw new Error(`创建目录 ${currentPath} 失败: ${error.message}`)
    }
  }
}

/**
 * Upload file, automatically create parent directories if they do not exist.
 * @param path full file path, e.g., /LX_Music/playlists.json
 * @param content file content
 */
export async function uploadFile(path: string, content: string): Promise<void> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')

  // 1. 提取目录路径
  const dirPath = path.substring(0, path.lastIndexOf('/'))

  // 2. 确保目录存在
  await ensureDirectoryExists(cli, dirPath)

  // 3. 上传文件
  webDAVLog.info(`All directories exist. Uploading file to ${path}...`)
  await cli.putFileContents(path, content, { overwrite: true })
}

/**
 * 上传本地二进制文件（如音频）到 WebDAV 服务器。
 * @param remotePath 服务器上的完整目标路径，如 /Music/song.mp3
 * @param localPath 本地文件完整路径
 * @param contentType 可选的 Content-Type，不传则由服务端按扩展名推断
 *
 * 注意：通过 base64 中转读入内存再转 Buffer，大文件（>100MB）可能内存吃紧，
 * 调用方应对超大文件先提示用户。真机上的二进制 PUT 行为待验证。
 */
export async function uploadBinaryFile(
  remotePath: string,
  localPath: string,
  contentType?: string,
  // 2026-10-05：分阶段上报，用于定位上传卡死位置
  onStage?: (stage: string) => void,
): Promise<void> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')

  onStage?.('正在创建目录...')
  const dirPath = remotePath.substring(0, remotePath.lastIndexOf('/'))
  await ensureDirectoryExists(cli, dirPath)

  onStage?.('正在读取文件...')
  const fileInfo = await stat(localPath).catch(() => null)
  const size = fileInfo?.size ?? 0
  webDAVLog.info(`Uploading binary file to ${remotePath}...`, { size })

  // 2026-10-05：用 webdav 库的 putFileContents（库内部处理 URL 编码和认证）
  // 之前 fetch+Blob 在 RN iOS 上不可靠，改回库方法
  const base64 = await readFile(localPath, 'base64')
  const buffer = Buffer.from(base64, 'base64')

  onStage?.('正在上传到服务器...')

  // 加超时保护，避免无限卡死
  // 注意：超时后底层请求仍在后台继续，仅用于给用户反馈，实际上传可能稍后完成
  const timeoutMs = 120000 // 2 分钟
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const uploadPromise = cli.putFileContents(remotePath, buffer, {
    overwrite: true,
    ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
  }).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('上传超时（2分钟），请检查网络后重试')), timeoutMs)
  })
  await Promise.race([uploadPromise, timeoutPromise])

  webDAVLog.info(`Upload completed: ${remotePath}`)
}

/**
 * Download file, return null if file does not exist.
 * @param path full file path
 */
export async function downloadFile(path: string): Promise<string | null> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')
  try {
    webDAVLog.info(`Attempting to download file: ${path}`)
    return await cli.getFileContents(path, { format: 'text' })
  } catch (error: any) {
    if (error.status === 404 || error.status === 409) {
      webDAVLog.info(`downloadFile: File not found on server: ${path}`)
      return null
    }
    webDAVLog.error(`downloadFile: Unexpected error for "${path}":`, error)
    throw error
  }
}

/**
 * Get file status, return null if file does not exist.
 * @param path full file path
 */
export async function getStat(path: string): Promise<any | null> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')
  try {
    return await cli.stat(path) as Promise<FileStat>
  } catch (error: any) {
    if (error.status === 404 || error.status === 409) {
      webDAVLog.info(`getStat: File or path not found for "${path}", returning null.`)
      return null
    }
    webDAVLog.error(`getStat: Unexpected error for "${path}":`, error)
    throw error
  }
}
