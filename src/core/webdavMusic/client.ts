import { Buffer } from 'buffer'
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

/** 连通性测试：读根目录，成功返回 true，失败抛错（15 秒超时防 hang） */
export const testConnection = async(): Promise<boolean> => {
  const client = getClient()
  await Promise.race([
    client.getDirectoryContents('/'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时（15秒无响应）')), 15000)),
  ])
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
  // P1-2：只要有用户名就发 Authorization 头（密码为空也发，符合 RFC 7617）。
  // 之前 `username && password` 为空密码时省略整个头，若服务器要求认证，
  // 会按"未认证返回 404 隐藏文件存在"策略回 404，误导排查。
  if (username) {
    // P1-11：btoa 只支持 Latin1，用户名/密码含中文会抛 InvalidCharacterError 或生成错误 header。
    // 改用 Buffer（项目已依赖），按 UTF-8 编码。
    try {
      headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password ?? ''}`, 'utf8').toString('base64')
    } catch {
      // Buffer 不可用时回退到 btoa（旧行为）
      headers.Authorization = 'Basic ' + btoa(`${username}:${password ?? ''}`)
    }
  } else {
    webDAVLog.warn('getWebDAVAuthHeaders: 未配置用户名，不发送 Authorization 头')
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

  // Base URL 的路径部分必须编码：原生网络层（XHR/RNFS → iOS NSURL）要求严格编码的 URL，
  // 未编码的中文/括号会导致 NSURL 解析失败（nil），XHR 直接崩溃，RNFS 则 404。
  // 注意：webdav 库（JS 层）的 getFileDownloadLink 不编码 base 也能工作，但那是 JS 的 HTTP 客户端；
  // getWebDAVRemoteUrl 专供原生请求使用，必须编码。
  // 编码时用 decode-then-encode 保证幂等（防用户已手动编码导致的双重编码）。
  // 注意：不用 new URL() 解析——Hermes 对含中文的 URL 解析可能失败，导致回退到未编码版本。
  // 改用手动切分 protocol+host 与 path，保证任何情况下都编码。
  let baseUrl = creds.url.endsWith('/') ? creds.url.slice(0, -1) : creds.url
  const encodedFilePath = remote
    .substring(1)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  // 手动切分：找到 path 起始位置（protocol://host 之后的第一个 /）
  // 同时处理 query/hash：path 只取到 ? 或 # 之前
  const encodeBasePath = (url: string): string => {
    const protoIdx = url.indexOf('://')
    if (protoIdx < 0) return url // 非法 URL，原样返回（xhr.open 前校验会拦截）
    const pathStart = url.indexOf('/', protoIdx + 3)
    if (pathStart < 0) return url // 无 path，原样返回
    // 找 query/hash 起始
    let pathEnd = url.length
    const qIdx = url.indexOf('?', pathStart)
    const hIdx = url.indexOf('#', pathStart)
    if (qIdx >= 0) pathEnd = Math.min(pathEnd, qIdx)
    if (hIdx >= 0) pathEnd = Math.min(pathEnd, hIdx)
    const prefix = url.substring(0, pathStart) // protocol://host:port
    const pathPart = url.substring(pathStart, pathEnd) // /DRH(主)/备份/LX_Music
    const suffix = url.substring(pathEnd) // ?query 或 #hash 或空
    const encodedPath = pathPart
      .split('/')
      .map(seg => {
        try {
          return encodeURIComponent(decodeURIComponent(seg))
        } catch {
          return encodeURIComponent(seg)
        }
      })
      .join('/')
      .replace(/\/+$/, '') // 去末尾斜杠
    return prefix + encodedPath + '/' + encodedFilePath + suffix
  }
  return encodeBasePath(baseUrl)
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
