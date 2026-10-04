import { getData, saveData } from '@/plugins/storage'
import { createClient, type FileStat } from 'webdav'
import settingState from '@/store/setting/state'
import { webDAVLog } from './logger'
import { btoa } from 'react-native-quick-base64'
import { downloadFile, existsFile, mkdir, temporaryDirectoryPath, unlink, read, moveFile } from '@/utils/fs'
import { enforceCacheLimit } from '@/utils/nativeModules/cache'
import { stringMd5 } from 'react-native-quick-md5'
import { getStat, uploadBinaryFile } from '@/utils/webdav'

const CONFIG_KEY = '@webdav_music_config'
const audioExts = new Set([
  'mp3',
  'flac',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'ape',
])

// 网盘内可作为封面的图片扩展名 + 目录级通用封面文件名
const picExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
const genericPicNames = new Set(['cover', 'folder', 'front', 'album', 'back', 'poster', 'thumb'])

async function getClient() {
  const settings = settingState.setting
  const url = settings['sync.webdav.url']
  const username = settings['sync.webdav.username']
  const password = settings['sync.webdav.password']

  if (!url || !username) {
    webDAVLog.error('WebDAV 未配置')
    throw new Error('WebDAV 未配置')
  }

  // createClient imported at top
  return createClient(url, { username, password })
}

const normalizePath = (path: string | undefined, name: string) => {
  return path ? `${path}/${name}` : `/${name}`
}

const getExt = (name: string) => {
  const ext = name.split('.').pop()
  return ext && ext != name ? ext.toLowerCase() : ''
}

const getBaseName = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const parseFileName = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf('.')
  const rawName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  if (!rawName.includes('-')) return { name: rawName.trim(), singer: '' }
  const [left, ...rest] = rawName.split('-')
  return {
    name: left.trim(),
    singer: rest.join('-').trim(),
  }
}

export const getWebDAVConfig = async(): Promise<LX.WebDAV.Config> => {
  const config = (await getData<LX.WebDAV.Config>(CONFIG_KEY)) ?? {
    selectedFolder: null,
    songs: [],
    filterPath: null,
  }
  config.songs = (config.songs ?? []).map(normalizeWebDAVMusicInfo)
  return config
}

export const saveWebDAVFilterPath = async(filterPath: string | null) => {
  const config = await getWebDAVConfig()
  config.filterPath = filterPath
  await saveWebDAVConfig(config)
  return config
}

export const saveWebDAVConfig = async(config: LX.WebDAV.Config) => {
  await saveData(CONFIG_KEY, config)
}

export const listWebDAVFolders = async(folder?: LX.WebDAV.DriveFolder | null) => {
  const client = await getClient()
  const basePath = folder?.path ?? '/'

  let contents: Array<any & { type: string }>
  try {
    contents = await client.getDirectoryContents(basePath) as Array<any & { type: string }>
  } catch (error: any) {
    webDAVLog.error('listWebDAVFolders error', { error, status: error.status })
    if (error.status === 404 || error.status === 409) {
      return []
    }
    throw error
  }

  return contents
    .filter(item => item.type === 'directory')
    .sort((a, b) => a.basename.localeCompare(b.basename))
    .map<LX.WebDAV.DriveFolder>(item => ({
    id: item.filename,
    name: item.basename,
    parentId: folder?.id,
    path: normalizePath(folder?.path, item.basename),
  }))
}

export const saveWebDAVSelectedFolder = async(folder: LX.WebDAV.DriveFolder | null) => {
  const config = await getWebDAVConfig()
  config.selectedFolder = folder
  await saveWebDAVConfig(config)
  return config
}

const toMusicInfo = (item: FileStat, path: string): LX.WebDAV.MusicInfo => {
  const ext = getExt(item.basename)
  const title = parseFileName(item.basename)
  const modifiedTime = item.lastmod ? new Date(item.lastmod).getTime() : 0
  return {
    id: `webdav_${item.filename}`,
    name: title.name,
    singer: title.singer,
    source: 'local',
    interval: null,
    meta: {
      webdav: true,
      fileName: item.basename,
      // 注意：meta.filePath 只表示**本地已下载文件**（播放链路 existsFile / 读标签 /
      // 编辑标签都按本地文件用它）。远程路径必须只放 remotePath ——
      // 旧实现把扫描到的远程路径写进 filePath，导致「未下载」被当成「已下载」，
      // 读/编辑标签去读一个根本不在本地的路径，下拉刷新永远假成功。
      filePath: '',
      remotePath: path,
      ext,
      size: item.size,
      lastModifiedTime: modifiedTime,
      songId: path,
      albumName: '',
    },
  }
}

export const normalizeWebDAVMusicInfo = (musicInfo: LX.WebDAV.MusicInfo) => {
  const remotePath = musicInfo.meta.remotePath
  // 旧数据迁移：早期扫描把远程路径写进了 filePath（见 toMusicInfo 的注释），
  // 这里清掉，让「本地已下载」的判定恢复正确。
  if (remotePath && musicInfo.meta.filePath === remotePath) musicInfo.meta.filePath = ''
  // 只在名称/歌手缺失时用文件名兜底：已有值可能来自「下载后读标签」或「编辑标签」，
  // 旧实现每次读取配置都拿文件名重解析，会把读到的标签重新洗掉。
  const title = parseFileName(musicInfo.meta.fileName || musicInfo.name || '')
  if (!musicInfo.name) musicInfo.name = title.name
  if (!musicInfo.singer) musicInfo.singer = title.singer
  return musicInfo
}

const scanFolder = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
) => {
  const client = await getClient()
  const result: LX.WebDAV.MusicInfo[] = []
  const basePath = folder?.path ?? '/'

  let contents: Array<any & { type: string }>
  try {
    contents = await client.getDirectoryContents(basePath) as Array<any & { type: string }>
  } catch (error: any) {
    webDAVLog.error('scanFolder error', { error, status: error.status })
    if (error.status === 404 || error.status === 409) {
      return result
    }
    throw error
  }

  // 第一遍：收集当前目录的图片与歌词文件，供同名/通用封面匹配
  const picMap = new Map<string, string>()
  const lrcMap = new Map<string, string>()
  let genericPic = ''
  for (const item of contents) {
    if (item.type !== 'file') continue
    const ext = getExt(item.basename)
    const path = normalizePath(folder?.path, item.basename)
    const base = getBaseName(item.basename).toLowerCase()
    if (ext === 'lrc') {
      lrcMap.set(base, path)
    } else if (picExts.has(ext)) {
      picMap.set(base, path)
      if (genericPicNames.has(base)) genericPic = path
    }
  }

  // 第二遍：处理子目录与音频
  for (const item of contents) {
    const path = normalizePath(folder?.path, item.basename)
    if (item.type === 'directory') {
      try {
        result.push(
          ...(await scanFolder(
            { id: item.filename, name: item.basename, parentId: folder?.id, path },
            onProgress,
          )),
        )
      } catch (error: any) {
        webDAVLog.error('scanFolder recursive error', { path, error, status: error.status })
        // Skip folders that return 403 or other errors
      }
      onProgress?.(result.length, path)
      continue
    }
    if (item.type !== 'file') continue
    const ext = getExt(item.basename)
    if (!audioExts.has(ext)) continue
    const musicInfo = toMusicInfo(item, path)
    // 网盘内封面/歌词：优先同目录同名，其次目录通用封面
    const audioBase = getBaseName(item.basename).toLowerCase()
    const picPath = picMap.get(audioBase) ?? genericPic
    const lrcPath = lrcMap.get(audioBase)
    if (picPath) musicInfo.meta.picPath = picPath
    if (lrcPath) musicInfo.meta.lrcPath = lrcPath
    result.push(musicInfo)
  }
  return result
}

export const scanWebDAVSongs = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
) => {
  const songs = await scanFolder(folder, onProgress)
  songs.sort((a, b) => b.meta.lastModifiedTime - a.meta.lastModifiedTime)

  const config = await getWebDAVConfig()
  const existingSongsMap = new Map<string, LX.WebDAV.MusicInfo>()
  for (const song of config.songs ?? []) {
    existingSongsMap.set(song.id, song)
  }

  const mergedSongs = songs.map(newSong => {
    const existing = existingSongsMap.get(newSong.id)
    if (existing) Object.assign(newSong.meta, existing.meta)
    return newSong
  })

  config.selectedFolder = folder
  config.songs = mergedSongs
  config.scannedAt = Date.now()
  await saveWebDAVConfig(config)
  return config
}

// WebDAV 直链播放/下载的认证 headers：服务器通常需 Basic 认证
export const getWebDAVAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36',
  }
  const username = settingState.setting['sync.webdav.username']
  const password = settingState.setting['sync.webdav.password']
  if (username && password) {
    headers.Authorization = 'Basic ' + btoa(`${username}:${password}`)
  }
  return headers
}

// 播放/封面缓存目录（Caches，可被系统清理，不参与 iCloud 备份）。
// 注意与 getWebDAVPrivateDirectory（用户手动下载目录，位于 Documents）区分：
// 这里是流式播放自动预下载的临时缓存，可被系统回收；用户手动下载的文件要保留。
const getWebDAVCacheDirectory = () => `${temporaryDirectoryPath}/WebDAV`

// 由远程路径构造 WebDAV 直链 URL（保留 / 分隔，仅对每段编码）
const getWebDAVRemoteUrl = (remoteFilePath: string): string => {
  const url = settingState.setting['sync.webdav.url']
  if (!url) {
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
    webDAVLog.warn('getWebDAVRemoteUrl: detected local path in remoteFilePath', { remoteFilePath: remote })
  }

  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
  // 逐段编码：encodeURIComponent 会把路径分隔符 / 编成 %2F，
  // 整体编码后 URL 变成 "音乐%2F歌曲.mp3"，大多数 WebDAV 服务器
  // （坚果云/Alist/Nextcloud）会 404。正确做法是保留 / 分隔，
  // 只对每一段中的空格、中文、# 等特殊字符编码。
  const encodedFilePath = remote
    .substring(1)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `${baseUrl}/${encodedFilePath}`
}

export const getWebDAVDownloadUrl = (musicInfo: LX.WebDAV.MusicInfo) => {
  let remoteFilePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)

  if (remoteFilePath.includes('/storage/emulated/') || remoteFilePath.includes('/sdcard/') || remoteFilePath.includes('/storage/self/')) {
    webDAVLog.warn('getWebDAVDownloadUrl: detected local path in remoteFilePath, using songId instead', { remoteFilePath, songId: musicInfo.meta.songId })
    remoteFilePath = String(musicInfo.meta.songId || musicInfo.meta.filePath)
  }

  return getWebDAVRemoteUrl(remoteFilePath)
}

export interface WebDAVMusicMetaUpdate {
  picUrl?: string
  filePath?: string | null
  /** 标题/艺术家/专辑：下载后读标签、在线封面匹配、编辑标签都会回写 */
  name?: string
  singer?: string
  albumName?: string
}

export const updateWebDAVMusicMeta = async(musicId: string, update: WebDAVMusicMetaUpdate): Promise<void> => {
  const config = await getWebDAVConfig()
  const songIndex = config.songs.findIndex(song => song.id === musicId)
  if (songIndex === -1) {
    return
  }

  const song = config.songs[songIndex]
  if (update.picUrl !== undefined) {
    song.meta.picUrl = update.picUrl
  }
  // 标签类字段（此前被静默丢弃，导致「读取标签」只留下封面、名称/歌手/专辑不落库）
  if (update.name) song.name = update.name
  if (update.singer) song.singer = update.singer
  if (update.albumName !== undefined) song.meta.albumName = update.albumName
  // filePath 允许显式清空（传 null 或 ''）：文件被本地删除后需要清掉旧路径，
  // 否则播放链路会一直误判"已下载"而尝试读取不存在的文件。
  if (update.filePath !== undefined) {
    song.meta.filePath = update.filePath || ''
  }

  config.songs[songIndex] = song
  await saveWebDAVConfig(config)
}

/**
 * 兼容旧版本毒化缓存：此前下载未校验 statusCode，401/404 的错误页面
 * （XML/HTML，首字节必为 '<'）会被当成正常文件缓存。音频文件的首字节
 * 不可能是 '<'，命中则删掉并走正常下载流程；读不到首字节时保守地视为有效。
 */
const isPoisonedCache = async(filePath: string): Promise<boolean> => {
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
 * 2) 预加载与播放可能并发下载同一文件（见 core/player/preload.ts），唯一临时文件名
 *    保证互不删除对方的文件；改名时若目标已存在（另一路已先落盘）则直接复用。
 */
const downloadToFileAtomic = async(options: {
  url: string
  targetPath: string
  statusError: (statusCode: number) => string
  moveError: string
}): Promise<void> => {
  const { url, targetPath, statusError, moveError } = options
  const tmpPath = `${targetPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`
  const cleanupTmp = () => unlink(tmpPath).catch(() => {})
  try {
    const result = await downloadFile(url, tmpPath, { headers: getWebDAVAuthHeaders() }).promise
    if (result.statusCode < 200 || result.statusCode >= 300 || !result.bytesWritten) {
      webDAVLog.error('downloadToFileAtomic: 下载失败', { statusCode: result.statusCode, url })
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

// 拉取网盘内封面图片：下载到本地缓存目录，返回 file:// 本地路径
// （FastImage 固定 defaultHeaders，无法注入 Basic Auth，需先下载到本地）
export const fetchWebDAVPic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string | null> => {
  const picPath = musicInfo.meta.picPath
  if (!picPath) return null
  try {
    const url = getWebDAVRemoteUrl(picPath)
    const coversDir = `${getWebDAVCacheDirectory()}/covers`
    const ext = picPath.split('.').pop()?.toLowerCase() || 'jpg'
    // 同音频缓存：用 md5 避免 encodeURIComponent 与 downloadFile 内部 decodeURIComponent 冲突
    const localPath = `${coversDir}/${stringMd5(picPath)}.${ext}`
    if (await existsFile(localPath)) {
      if (!(await isPoisonedCache(localPath))) return `file://${localPath}`
      webDAVLog.warn('fetchWebDAVPic: 发现毒化缓存，删除后重新下载', { localPath })
      await unlink(localPath).catch(() => {})
    }
    await mkdir(coversDir)
    // 原子下载：statusCode 校验（401/404 的错误页面不能当封面缓存），
    // 网络中断 reject 时也不在目标路径留截断文件
    await downloadToFileAtomic({
      url,
      targetPath: localPath,
      statusError: (statusCode) => `cover download failed: ${statusCode}`,
      moveError: 'cover download failed: move failed',
    })
    return `file://${localPath}`
  } catch (err) {
    webDAVLog.warn('fetchWebDAVPic: failed', { err })
    return null
  }
}

// 拉取网盘内同名 .lrc 歌词文本（通过直链 + Basic Auth）
export const fetchWebDAVLrc = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string | null> => {
  const lrcPath = musicInfo.meta.lrcPath
  if (!lrcPath) return null
  try {
    const url = getWebDAVRemoteUrl(lrcPath)
    const response = await fetch(url, { headers: getWebDAVAuthHeaders() })
    if (!response.ok) return null
    const text = await response.text()
    return text?.trim() ? text : null
  } catch (err) {
    webDAVLog.warn('fetchWebDAVLrc: failed', { err })
    return null
  }
}

// 整文件预下载 WebDAV 音频到本地私有缓存目录，返回本地绝对路径。
// iOS 的 AVPlayer 无法可靠注入 Authorization/User-Agent 头，
// 直链流式播放不稳定，改为用 downloadFile（NSURLSession，能正确携带 Basic Auth）
// 先下载到私有缓存，再播放本地文件。
export const downloadWebDAVMusic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string> => {
  const remotePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)
  const cacheDir = `${getWebDAVCacheDirectory()}/music`
  const ext = musicInfo.meta.ext || getExt(musicInfo.meta.fileName || remotePath)
  // 缓存文件名用 remotePath 的 md5：downloadFile 内部 normalizePath 会 decodeURIComponent，
  // 若用 encodeURIComponent(remotePath) 生成文件名，下载实际写入的是“解码后”路径，而返回给
  // 播放器的是“编码后”路径，两者不一致导致播放器找不到文件、无法播放。
  const filePath = `${cacheDir}/${stringMd5(remotePath)}.${ext}`

  if (await existsFile(filePath)) {
    if (!(await isPoisonedCache(filePath))) return filePath
    webDAVLog.warn('downloadWebDAVMusic: 发现毒化缓存（错误页面），删除后重新下载', { filePath })
    await unlink(filePath).catch(() => {})
  }

  await mkdir(cacheDir)
  const downloadUrl = getWebDAVDownloadUrl(musicInfo)
  // BUG 修复：RNFS downloadFile 的 promise 在 HTTP 报错（401/403/404 等）时不会 reject，
  // 而是 resolve 并把错误页面写进目标文件；网络中断时则 reject 并留下截断文件。
  // 原来不检查 statusCode，直接把"错误页面"当成音频返回给播放器 → 现象就是能连上
  // 服务器、能看到歌单但听不了；更糟的是毒化缓存（下次 existsFile 直接命中坏文件，
  // 瞬间"失败"，连重试下载的机会都没有，而截断文件连首字节 '<' 检查都识别不出）。
  // 原子下载保证任何失败都不会污染目标路径。
  await downloadToFileAtomic({
    url: downloadUrl,
    targetPath: filePath,
    statusError: (statusCode) => {
      const hint = statusCode === 401 || statusCode === 403
        ? '，请检查用户名密码（暂仅支持 Basic 认证）'
        : statusCode === 404
          ? '，服务器上找不到该文件，请重新扫描歌单'
          : ''
      return `WebDAV 下载失败（${statusCode}）${hint}`
    },
    moveError: 'WebDAV 下载失败（文件落盘失败）',
  })

  // 下载完成后按上限对全部应用缓存做 LRU 清理，避免缓存无限累积
  // （不仅清 WebDAV 子目录，让 getAppCacheSize 显示的总大小也收敛到上限内）
  void enforceCacheLimit((settingState.setting['player.cacheLimit'] || 0) * 1024 * 1024)

  return filePath
}

export interface WebDAVUploadItem {
  /** 本地文件完整路径 */
  localPath: string
  /** 文件名（含扩展名），将作为服务器上的文件名 */
  fileName: string
  /** 文件大小（字节），用于上传前提示 */
  size: number
}

/** 拼接远端目录与文件名，保证单斜杠分隔 */
export const joinWebDAVRemotePath = (remoteDir: string, fileName: string): string => {
  const dir = `/${remoteDir || ''}/`.replace(/\/{2,}/g, '/')
  return `${dir}${fileName}`.replace(/\/{2,}/g, '/')
}

/** 检查服务器上是否已存在该路径（存在返回 true，不存在返回 false） */
export const checkWebDAVRemoteExists = async(remotePath: string): Promise<boolean> => {
  return (await getStat(remotePath).catch(() => null)) != null
}

/**
 * 上传本地音频文件到 WebDAV 服务器指定目录。
 * @param item 本地文件信息
 * @param remoteDir 服务器目标目录，如 /Music；传空字符串表示根目录
 * @returns 服务器上的完整路径
 */
export const uploadWebDAVMusicFile = async(item: WebDAVUploadItem, remoteDir: string): Promise<string> => {
  const remotePath = joinWebDAVRemotePath(remoteDir, item.fileName)
  const ext = item.fileName.split('.').pop()?.toLowerCase() ?? ''
  const contentType = ext === 'mp3' ? 'audio/mpeg'
    : ext === 'flac' ? 'audio/flac'
    : ext === 'wav' ? 'audio/wav'
    : ext === 'm4a' ? 'audio/mp4'
    : ext === 'aac' ? 'audio/aac'
    : ext === 'ogg' || ext === 'oga' ? 'audio/ogg'
    : ext === 'opus' ? 'audio/opus'
    : ext === 'wma' ? 'audio/x-ms-wma'
    : ext === 'ape' ? 'audio/ape'
    : undefined
  await uploadBinaryFile(remotePath, item.localPath, contentType)
  return remotePath
}
