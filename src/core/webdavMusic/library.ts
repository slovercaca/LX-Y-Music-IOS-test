import { getData, saveData } from '@/plugins/storage'
import settingState from '@/store/setting/state'
import { stringMd5 } from 'react-native-quick-md5'
import { existsFile, mkdir, temporaryDirectoryPath, unlink } from '@/utils/fs'
import { enforceCacheLimit } from '@/utils/nativeModules/cache'
import { getWebDAVRemoteUrl, getWebDAVAuthHeaders, getWebDAVMusicDir, getWebDAVLrcDir, joinWebDAVRemotePath } from './client'
import {
  downloadToFileAtomic,
  isPoisonedCache,
  listRemoteEntries,
  listRemoteSubDirs,
  uploadBinaryFile,
  type RemoteEntry,
} from './files'
import { webDAVLog } from './logger'

/**
 * WebDAV 歌曲库（重写版）。
 *
 * 职责：「我的」页的全部歌曲域逻辑——扫描、配置持久化、封面/歌词拉取、
 * 播放用下载、上传。远端读写只走 files.ts，连接只走 client.ts。
 *
 * 兼容承诺（100%）：
 * - 存储键 '@webdav_music_config' 与数据结构不变
 *   （{selectedFolder, songs, scannedAt, filterPath}）
 * - 歌曲 id 仍为 `webdav_${filename}`；meta 字段语义不变
 *   （filePath 只表示本地已下载文件，远程路径只放 remotePath）
 * - 播放缓存仍在 Caches/WebDAV/music/<md5(remotePath)>.<ext>，
 *   封面缓存在 Caches/WebDAV/covers/<md5(picPath)>.<ext>
 * - 上传目录语义不变：音频进 musicDirFor(dir)，歌词进其兄弟 lrc/
 */

const CONFIG_KEY = '@webdav_music_config'

const audioExts = new Set([
  'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape',
])

// 网盘内可作为封面的图片扩展名 + 目录级通用封面文件名
const picExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
const genericPicNames = new Set(['cover', 'folder', 'front', 'album', 'back', 'poster', 'thumb'])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const getExt = (name: string): string => {
  const ext = name.split('.').pop()
  return ext && ext !== name ? ext.toLowerCase() : ''
}

const getBaseName = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 从「歌手 - 歌名」文件名解析出歌手/歌名 */
const parseFileName = (fileName: string): { name: string, singer: string } => {
  const dotIndex = fileName.lastIndexOf('.')
  const rawName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  if (!rawName.includes('-')) return { name: rawName.trim(), singer: '' }
  const [left, ...rest] = rawName.split('-')
  return { name: left.trim(), singer: rest.join('-').trim() }
}

/** 播放/封面缓存目录（Caches，可被系统清理，不参与 iCloud 备份） */
const getCacheDir = () => `${temporaryDirectoryPath}/WebDAV`

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

export const getWebDAVConfig = async(): Promise<LX.WebDAV.Config> => {
  const config = (await getData<LX.WebDAV.Config>(CONFIG_KEY)) ?? {
    selectedFolder: null,
    songs: [],
    filterPath: null,
  }
  config.songs = (config.songs ?? []).map(normalizeWebDAVMusicInfo)
  return config
}

export const saveWebDAVConfig = async(config: LX.WebDAV.Config): Promise<void> => {
  await saveData(CONFIG_KEY, config)
}

export const saveWebDAVFilterPath = async(filterPath: string | null): Promise<LX.WebDAV.Config> => {
  const config = await getWebDAVConfig()
  config.filterPath = filterPath
  await saveWebDAVConfig(config)
  return config
}

export const saveWebDAVSelectedFolder = async(
  folder: LX.WebDAV.DriveFolder | null,
): Promise<LX.WebDAV.Config> => {
  const config = await getWebDAVConfig()
  config.selectedFolder = folder
  await saveWebDAVConfig(config)
  return config
}

// ---------------------------------------------------------------------------
// 目录浏览
// ---------------------------------------------------------------------------

export const listWebDAVFolders = async(
  folder?: LX.WebDAV.DriveFolder | null,
): Promise<LX.WebDAV.DriveFolder[]> => {
  const basePath = folder?.path ?? '/'
  const subDirs = await listRemoteSubDirs(basePath)
  // 补上父级引用（files 层不感知 UI 的 folder 栈）
  return subDirs.map(d => ({ ...d, parentId: folder?.id }))
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

const toMusicInfo = (entry: RemoteEntry): LX.WebDAV.MusicInfo => {
  const ext = getExt(entry.name)
  const title = parseFileName(entry.name)
  const modifiedTime = entry.lastmod ? new Date(entry.lastmod).getTime() : 0
  return {
    id: `webdav_${entry.id}`,
    name: title.name,
    singer: title.singer,
    source: 'local',
    interval: null,
    meta: {
      webdav: true,
      fileName: entry.name,
      // 注意：meta.filePath 只表示**本地已下载文件**（播放链路 existsFile / 读标签 /
      // 编辑标签都按本地文件用它）。远程路径必须只放 remotePath ——
      // 旧实现把扫描到的远程路径写进 filePath，导致「未下载」被当成「已下载」。
      filePath: '',
      remotePath: entry.path,
      ext,
      size: entry.size,
      lastModifiedTime: modifiedTime,
      songId: entry.path,
      albumName: '',
    },
  }
}

export const normalizeWebDAVMusicInfo = (musicInfo: LX.WebDAV.MusicInfo): LX.WebDAV.MusicInfo => {
  const remotePath = musicInfo.meta.remotePath
  // 旧数据迁移：早期扫描把远程路径写进了 filePath，这里清掉，
  // 让「本地已下载」的判定恢复正确。
  if (remotePath && musicInfo.meta.filePath === remotePath) musicInfo.meta.filePath = ''
  // 只在名称/歌手缺失时用文件名兜底：已有值可能来自「下载后读标签」或「编辑标签」，
  // 每次读取配置都拿文件名重解析会把读到的标签重新洗掉。
  const title = parseFileName(musicInfo.meta.fileName || musicInfo.name || '')
  if (!musicInfo.name) musicInfo.name = title.name
  if (!musicInfo.singer) musicInfo.singer = title.singer
  return musicInfo
}

interface ScanMediaMaps {
  picMap: Map<string, string>
  lrcMap: Map<string, string>
  genericPic: string
}

/** 读取某目录下的 .lrc，记入 lrcMap（已存在的同名不覆盖，调用方目录优先） */
const loadLrcDirInto = async(lrcDirPath: string, lrcMap: Map<string, string>): Promise<void> => {
  try {
    const entries = await listRemoteEntries(lrcDirPath)
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (getExt(entry.name) !== 'lrc') continue
      const base = getBaseName(entry.name).toLowerCase()
      if (!lrcMap.has(base)) lrcMap.set(base, entry.path)
    }
  } catch {
    // lrc 目录读取失败不影响主流程
  }
}

const scanFolder = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
  parentLrcMap?: Map<string, string>,
): Promise<LX.WebDAV.MusicInfo[]> => {
  const result: LX.WebDAV.MusicInfo[] = []
  const basePath = folder?.path ?? '/'
  const entries = await listRemoteEntries(basePath)

  // 第一遍：收集本目录的图片与歌词，供同名/通用封面匹配
  const media: ScanMediaMaps = { picMap: new Map(), lrcMap: new Map(), genericPic: '' }

  // 新目录结构：music/ 放歌曲，lrc/ 放歌词——子目录 lrc/ 也纳入匹配
  const lrcSubdir = entries.find(e => e.type === 'directory' && e.name.toLowerCase() === 'lrc')
  if (lrcSubdir) await loadLrcDirInto(lrcSubdir.path, media.lrcMap)

  // 扫描的如果是 music 目录本身，歌词在兄弟 lrc/ 目录（如 /music ↔ /lrc），也纳入匹配，
  // 否则上传后"歌词进 lrc/"但扫描 /music 时永远匹配不上
  const folderBase = basePath.split('/').filter(Boolean).pop()?.toLowerCase()
  if (folderBase === 'music' && folder?.path) {
    const parentPath = folder.path.substring(0, folder.path.lastIndexOf('/')) || '/'
    try {
      const parentEntries = await listRemoteEntries(parentPath)
      const siblingLrc = parentEntries.find(e => e.type === 'directory' && e.name.toLowerCase() === 'lrc')
      if (siblingLrc) await loadLrcDirInto(siblingLrc.path, media.lrcMap)
    } catch {
      // 父目录不可读不影响主流程
    }
  }

  // 父目录的歌词映射作为 fallback（父级优先度低，不覆盖本地）
  if (parentLrcMap) {
    for (const [base, path] of parentLrcMap) {
      if (!media.lrcMap.has(base)) media.lrcMap.set(base, path)
    }
  }

  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const ext = getExt(entry.name)
    const base = getBaseName(entry.name).toLowerCase()
    if (ext === 'lrc') {
      media.lrcMap.set(base, entry.path)
    } else if (picExts.has(ext)) {
      media.picMap.set(base, entry.path)
      if (genericPicNames.has(base)) media.genericPic = entry.path
    }
  }

  // 第二遍：递归子目录 + 收集音频
  for (const entry of entries) {
    if (entry.type === 'directory') {
      try {
        result.push(
          ...(await scanFolder(
            { id: entry.id, name: entry.name, parentId: folder?.id, path: entry.path },
            onProgress,
            // 把当前目录的歌词映射传给子目录
            media.lrcMap,
          )),
        )
      } catch (error: any) {
        webDAVLog.error('scanFolder recursive error', { path: entry.path, status: error?.status })
        // 403 等错误的目录直接跳过，不中断整棵扫描
      }
      onProgress?.(result.length, entry.path)
      continue
    }
    if (entry.type !== 'file') continue
    if (!audioExts.has(getExt(entry.name))) continue
    const musicInfo = toMusicInfo(entry)
    // 网盘内封面/歌词：优先同目录同名，其次目录通用封面
    const audioBase = getBaseName(entry.name).toLowerCase()
    const picPath = media.picMap.get(audioBase) ?? media.genericPic
    const lrcPath = media.lrcMap.get(audioBase)
    if (picPath) musicInfo.meta.picPath = picPath
    if (lrcPath) musicInfo.meta.lrcPath = lrcPath
    result.push(musicInfo)
  }
  return result
}

export const scanWebDAVSongs = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
): Promise<LX.WebDAV.Config> => {
  const songs = await scanFolder(folder, onProgress)
  songs.sort((a, b) => b.meta.lastModifiedTime - a.meta.lastModifiedTime)

  const config = await getWebDAVConfig()
  const existingSongsMap = new Map<string, LX.WebDAV.MusicInfo>()
  for (const song of config.songs ?? []) {
    existingSongsMap.set(song.id, song)
  }

  const mergedSongs = songs.map(newSong => {
    const existing = existingSongsMap.get(newSong.id)
    if (existing) {
      // 只合并白名单本地字段，保留用户本地状态；
      // 服务器扫描的新值（size、lastModifiedTime、picPath、lrcPath 等）优先，
      // 否则服务器上文件被替换后重扫仍显示旧大小/时间
      const localFields = ['filePath', 'picUrl', 'customPicPath', 'customLrcPath', 'albumName', 'name', 'singer'] as const
      for (const key of localFields) {
        // P1-B：name/singer 在 MusicInfo 顶层，不在 meta 里。从 meta 取会得 undefined，
        // 导致用户手动编辑的歌名/歌手在重扫时被覆盖（数据丢失）。
        const isTopLevel = key === 'name' || key === 'singer'
        const oldVal = isTopLevel ? (existing as any)[key] : (existing.meta as any)[key]
        if (oldVal !== undefined) {
          if (isTopLevel) (newSong as any)[key] = oldVal
          else (newSong.meta as any)[key] = oldVal
        }
      }
    }
    return newSong
  })

  // P0-2（2026-10-06）：扫描期间新增的歌曲不能丢。
  // 场景：扫描耗时数分钟，期间用户下载了新歌（updateWebDAVMusicMeta 写回），
  // 若新歌不在本次扫描结果里，直接写回 mergedSongs 会把它丢掉。
  // 保留有本地状态（已下载/自定义封面/歌词）的、但不在扫描结果中的歌曲。
  const scannedIds = new Set(mergedSongs.map(s => s.id))
  for (const existing of config.songs ?? []) {
    if (!scannedIds.has(existing.id)) {
      const hasLocalState = !!(existing.filePath || existing.customPicPath || existing.customLrcPath)
      if (hasLocalState) {
        mergedSongs.push(existing)
      }
    }
  }

  config.selectedFolder = folder
  config.songs = mergedSongs
  config.scannedAt = Date.now()
  await saveWebDAVConfig(config)
  return config
}

// ---------------------------------------------------------------------------
// 下载 URL
// ---------------------------------------------------------------------------

export const getWebDAVDownloadUrl = (musicInfo: LX.WebDAV.MusicInfo): string => {
  let remoteFilePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)

  if (remoteFilePath.includes('/storage/emulated/') || remoteFilePath.includes('/sdcard/') || remoteFilePath.includes('/storage/self/')) {
    webDAVLog.warn('getWebDAVDownloadUrl: 远端路径里混入了本机路径，改用 songId', { remoteFilePath })
    remoteFilePath = String(musicInfo.meta.songId || musicInfo.meta.filePath)
  }

  // P0-1：空路径时直接抛错，不调 getWebDAVRemoteUrl。
  // 空路径会拼出 baseUrl + "/"（目录地址），下载到 HTML 目录页并被当作音频缓存（毒缓存），永久播不出。
  const trimmed = remoteFilePath.trim()
  if (!trimmed || trimmed === '/' || trimmed === 'undefined' || trimmed === 'null') {
    throw new Error(`无法下载：歌曲远端路径为空（fileName=${musicInfo.meta.fileName}）`)
  }

  return getWebDAVRemoteUrl(remoteFilePath)
}

// ---------------------------------------------------------------------------
// meta 更新
// ---------------------------------------------------------------------------

export interface WebDAVMusicMetaUpdate {
  picUrl?: string
  filePath?: string | null
  /** 标题/艺术家/专辑：下载后读标签、在线封面匹配、编辑标签都会回写 */
  name?: string
  singer?: string
  albumName?: string
  /** 手动指定的本地封面/歌词文件路径（每首歌单独配置，允许用 '' 清除） */
  customPicPath?: string
  customLrcPath?: string
}

export const updateWebDAVMusicMeta = async(
  musicId: string,
  update: WebDAVMusicMetaUpdate,
): Promise<void> => {
  const config = await getWebDAVConfig()
  const songIndex = config.songs.findIndex(song => song.id === musicId)
  if (songIndex === -1) return

  const song = config.songs[songIndex]
  if (update.picUrl !== undefined) {
    song.meta.picUrl = update.picUrl
  }
  // 标签类字段（此前曾被静默丢弃，导致「读取标签」只留下封面、名称/歌手/专辑不落库）
  if (update.name) song.name = update.name
  if (update.singer) song.singer = update.singer
  if (update.albumName !== undefined) song.meta.albumName = update.albumName
  // filePath 允许显式清空（传 null 或 ''）：文件被本地删除后需要清掉旧路径，
  // 否则播放链路会一直误判"已下载"而尝试读取不存在的文件。
  if (update.filePath !== undefined) {
    song.meta.filePath = update.filePath || ''
  }
  // 手动指定的封面/歌词文件路径（'' 表示清除，恢复自动获取）
  if (update.customPicPath !== undefined) {
    if (update.customPicPath) song.meta.customPicPath = update.customPicPath
    else delete song.meta.customPicPath
  }
  if (update.customLrcPath !== undefined) {
    if (update.customLrcPath) song.meta.customLrcPath = update.customLrcPath
    else delete song.meta.customLrcPath
  }

  config.songs[songIndex] = song
  await saveWebDAVConfig(config)
}

// ---------------------------------------------------------------------------
// 封面 / 歌词拉取
// ---------------------------------------------------------------------------

/**
 * 拉取网盘内封面图片：下载到本地缓存目录，返回 file:// 本地路径
 * （FastImage 固定 defaultHeaders，无法注入 Basic Auth，需先下载到本地）
 */
export const fetchWebDAVPic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string | null> => {
  const picPath = musicInfo.meta.picPath
  if (!picPath) return null
  try {
    const url = getWebDAVRemoteUrl(picPath)
    const coversDir = `${getCacheDir()}/covers`
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

/** 拉取网盘内同名 .lrc 歌词文本（通过直链 + Basic Auth） */
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

// ---------------------------------------------------------------------------
// 播放用下载
// ---------------------------------------------------------------------------

/**
 * 整文件预下载 WebDAV 音频到本地私有缓存目录，返回本地绝对路径。
 * iOS 的 AVPlayer 无法可靠注入 Authorization/User-Agent 头，
 * 直链流式播放不稳定，改为用 downloadFile（NSURLSession，能正确携带 Basic Auth）
 * 先下载到私有缓存，再播放本地文件。
 */
export const downloadWebDAVMusic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string> => {
  const remotePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)
  const cacheDir = `${getCacheDir()}/music`
  const ext = musicInfo.meta.ext || getExt(musicInfo.meta.fileName || remotePath)
  // 缓存文件名用 remotePath 的 md5：downloadFile 内部 normalizePath 会 decodeURIComponent，
  // 若用 encodeURIComponent(remotePath) 生成文件名，下载实际写入的是"解码后"路径，而返回给
  // 播放器的是"编码后"路径，两者不一致导致播放器找不到文件、无法播放。
  const filePath = `${cacheDir}/${stringMd5(remotePath)}.${ext}`

  if (await existsFile(filePath)) {
    if (!(await isPoisonedCache(filePath))) return filePath
    webDAVLog.warn('downloadWebDAVMusic: 发现毒化缓存（错误页面），删除后重新下载', { filePath })
    await unlink(filePath).catch(() => {})
  }

  await mkdir(cacheDir)
  const downloadUrl = getWebDAVDownloadUrl(musicInfo)
  // RNFS downloadFile 的 promise 在 HTTP 报错（401/403/404 等）时不会 reject，
  // 而是 resolve 并把错误页面写进目标文件；网络中断时则 reject 并留下截断文件。
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

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

export interface WebDAVUploadItem {
  /** 本地文件完整路径 */
  localPath: string
  /** 文件名（含扩展名），将作为服务器上的文件名 */
  fileName: string
  /** 文件大小（字节），用于上传前提示 */
  size: number
}

export const contentTypeForExt = (ext: string): string | undefined => {
  switch (ext) {
    case 'mp3': return 'audio/mpeg'
    case 'flac': return 'audio/flac'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'ogg':
    case 'oga': return 'audio/ogg'
    case 'opus': return 'audio/opus'
    case 'wma': return 'audio/x-ms-wma'
    case 'ape': return 'audio/ape'
    default: return undefined
  }
}

/**
 * 上传本地音频文件到 WebDAV 服务器指定目录。
 * @param item 本地文件信息
 * @param remoteDir 用户选择的扫描/上传根目录（如 / 或 /备份/LX_Musix）；
 *   实际音频目录由 getWebDAVMusicDir 推导（已是 music 目录时不再追加）
 * @param withLyrics 是否同时上传歌词：查找同名 .lrc，上传到 lrc/ 子目录
 * @returns 服务器上的完整路径（歌曲）
 */
export const uploadWebDAVMusicFile = async(
  item: WebDAVUploadItem,
  remoteDir: string,
  withLyrics = false,
  onStage?: (stage: string) => void,
): Promise<string> => {
  // 文件名可能带 URL 编码（%20 等）或丢失后缀。
  // 1. 先 decodeURIComponent 还原；2. 若无后缀，从 localPath 补后缀。
  let fileName = item.fileName
  try {
    // 只解码一次，避免双重解码破坏正常文件名中的 %
    if (/%[0-9A-Fa-f]{2}/.test(fileName)) {
      fileName = decodeURIComponent(fileName)
    }
  } catch {
    // 解码失败则用原名
  }
  // 确保带后缀：文件名无点号时，从本地路径取后缀补上
  if (!fileName.includes('.')) {
    const localExt = item.localPath.split('.').pop()
    if (localExt && localExt !== item.localPath) {
      fileName = `${fileName}.${localExt}`
    }
  }
  const musicRemoteDir = getWebDAVMusicDir(remoteDir)
  const remotePath = joinWebDAVRemotePath(musicRemoteDir, fileName)
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  await uploadBinaryFile(remotePath, item.localPath, contentTypeForExt(ext), onStage)

  // 同时上传歌词（如果勾选）：查找同名 .lrc，上传到 lrc/ 子目录
  if (withLyrics) {
    try {
      const baseName = fileName.replace(/\.[^/.]+$/, '')
      const lrcFileName = `${baseName}.lrc`
      // 查找位置：1. 音频同目录；2. 音频目录的 lrc/ 子目录；3. 父目录的 lrc/
      const localDir = item.localPath.substring(0, item.localPath.lastIndexOf('/'))
      const parentDir = localDir.substring(0, localDir.lastIndexOf('/'))
      const candidates = [
        `${localDir}/${lrcFileName}`,
        `${localDir}/lrc/${lrcFileName}`,
        `${parentDir}/lrc/${lrcFileName}`,
      ]
      for (const lrcPath of candidates) {
        if (await existsFile(lrcPath).catch(() => false)) {
          const lrcRemoteDir = getWebDAVLrcDir(remoteDir)
          const lrcRemotePath = joinWebDAVRemotePath(lrcRemoteDir, lrcFileName)
          await uploadBinaryFile(lrcRemotePath, lrcPath, 'text/plain')
          break
        }
      }
    } catch {
      // 歌词上传失败不影响歌曲
    }
  }

  return remotePath
}
