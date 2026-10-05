import settingState from '@/store/setting/state'
import { btoa } from 'react-native-quick-base64'
import { createClient } from 'webdav'
import { webDAVLog } from './logger'

/**
 * WebDAV 客户端单例与连接语义（重写版）。
 *
 * 职责：
 * - 从设置键 sync.webdav.url / username / password 读取凭据（与「设置 → 数据同步」
 *   共用同一批键，两边永远同源，100% 兼容原有配置）
 * - 全局只维护一个 client 实例：凭据变化时自动重建，不再各处各自 createClient
 *   （旧实现里 drive.ts 每次调用都新建 client，utils/webdav.ts 另缓存一个，
 *   两套实例行为不一致）
 * - 统一提供：Basic 认证头（fetch / RNFS 直链用）、远端路径 → 直链 URL
 *   （逐段编码，中文/空格/# 不再 404）、远端目录语义（music/lrc 目录推导）
 */

export interface WebDAVCredentials {
  url: string
  username: string
  password: string
}

/** 读取当前凭据；未配置（缺 url 或用户名）时返回 null */
export const readWebDAVCredentials = (): WebDAVCredentials | null => {
  const settings = settingState.setting
  const url = String(settings['sync.webdav.url'] ?? '').trim()
  const username = String(settings['sync.webdav.username'] ?? '')
  if (!url || !username) return null
  return { url, username, password: String(settings['sync.webdav.password'] ?? '') }
}

/** 是否已配置（地址 + 用户名齐全） */
export const isWebDAVConfigured = (): boolean => readWebDAVCredentials() !== null

let cachedClient: any = null
let cachedKey = ''

/**
 * 获取共享 client。凭据指纹变化时自动重建——调用方改完设置后无需手动 reset，
 * 但仍保留 resetClient() 供显式刷新（兼容旧 API）。
 * 未配置时抛 'WebDAV 未配置'（与旧行为一致）。
 */
export const getClient = (): any => {
  const creds = readWebDAVCredentials()
  if (!creds) {
    webDAVLog.error('WebDAV 未配置')
    throw new Error('WebDAV 未配置')
  }
  const key = `${creds.url}\n${creds.username}\n${creds.password}`
  if (!cachedClient || cachedKey !== key) {
    cachedClient = createClient(creds.url, { username: creds.username, password: creds.password })
    cachedKey = key
  }
  return cachedClient
}

/** 丢弃缓存的 client，下次 getClient() 重建（兼容旧 API） */
export const resetClient = (): void => {
  cachedClient = null
  cachedKey = ''
}

/** 连通性测试：读根目录，成功返回 true，失败抛错 */
export const testConnection = async(): Promise<boolean> => {
  const client = getClient()
  await client.getDirectoryContents('/')
  return true
}

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36'

/**
 * 直链下载/播放用的认证头：Basic 认证。
 * FastImage 与 RNFS downloadFile 无法复用 webdav 库的内部认证，必须显式带头。
 */
export const getWebDAVAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
  const username = settingState.setting['sync.webdav.username']
  const password = settingState.setting['sync.webdav.password']
  if (username && password) {
    headers.Authorization = 'Basic ' + btoa(`${username}:${password}`)
  }
  return headers
}

/**
 * 远端路径 → 可直接 GET 的直链 URL。
 * 逐段编码：encodeURIComponent 会把路径分隔符 / 编成 %2F，
 * 整体编码后 URL 变成 "音乐%2F歌曲.mp3"，大多数 WebDAV 服务器
 * （坚果云/Alist/Nextcloud）会 404。正确做法是保留 / 分隔，
 * 只对每一段中的空格、中文、# 等特殊字符编码。
 */
export const getWebDAVRemoteUrl = (remoteFilePath: string): string => {
  const creds = readWebDAVCredentials()
  if (!creds) {
    webDAVLog.error('getWebDAVRemoteUrl: WebDAV 未配置')
    throw new Error('WebDAV 未配置')
  }

  let remote = String(remoteFilePath || '')
  if (!remote.startsWith('/')) remote = '/' + remote

  if (
    remote.includes('/storage/emulated/') ||
    remote.includes('/sdcard/') ||
    remote.includes('/storage/self/')
  ) {
    webDAVLog.warn('getWebDAVRemoteUrl: 远端路径里混入了本机路径', { remoteFilePath: remote })
  }

  const baseUrl = creds.url.endsWith('/') ? creds.url.slice(0, -1) : creds.url
  const encodedFilePath = remote
    .substring(1)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `${baseUrl}/${encodedFilePath}`
}

/** 拼接远端目录与文件名，保证单斜杠分隔 */
export const joinWebDAVRemotePath = (remoteDir: string, fileName: string): string => {
  const dir = `/${remoteDir || ''}/`.replace(/\/{2,}/g, '/')
  return `${dir}${fileName}`.replace(/\/{2,}/g, '/')
}

/** 规范化远端目录：以 / 开头、无多余斜杠、无末尾斜杠（根目录除外） */
const normalizeRemoteDir = (remoteDir: string): string => {
  const cleaned = `/${remoteDir || ''}`.replace(/\/{2,}/g, '/')
  return cleaned.length > 1 ? cleaned.replace(/\/$/, '') : '/'
}

/**
 * 统一目录语义：音频目录。
 * - 用户选的是普通目录（如 / 或 /备份）→ 音频进 <dir>/music
 * - 用户选的已经是 music 目录（如 /music）→ 直接用它，不再追加 music
 * 上传、冲突预检、歌词目录推导、扫描兄弟目录匹配都必须走这个函数，
 * 禁止各处手写拼接（旧实现曾因此出现 /music/music）。
 */
export const getWebDAVMusicDir = (remoteDir: string): string => {
  const dir = normalizeRemoteDir(remoteDir)
  if (dir.split('/').pop()?.toLowerCase() === 'music') return dir
  return dir === '/' ? '/music' : `${dir}/music`
}

/**
 * 统一目录语义：歌词目录，永远是音频目录的兄弟 lrc/。
 * 如 /music → /lrc；/备份/music → /备份/lrc；/ → /lrc。
 */
export const getWebDAVLrcDir = (remoteDir: string): string => {
  const musicDir = getWebDAVMusicDir(remoteDir)
  if (musicDir === '/music') return '/lrc'
  return `${musicDir.substring(0, musicDir.lastIndexOf('/'))}/lrc`
}
