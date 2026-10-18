import {
  getMusicUrl as getOnlineMusicUrl,
  resolveMusicUrl as resolveOnlineMusicUrl,
  getPicUrl as getOnlinePicUrl,
  getLyricInfo as getOnlineLyricInfo,
} from './online'
import {
  getMusicUrl as getLocalMusicUrl,
  getPicUrl as getLocalPicUrl,
  getLyricInfo as getLocalLyricInfo,
} from './local'
import * as localPlay from './localPlay'
import { handleGetOnlinePicUrl } from './utils'
import { webDAVLog } from '@/core/webdavMusic/logger'
import settingState from '@/store/setting/state'
import downloadState from '@/store/download/state'
import { existsFile } from '@/utils/fs'

export { handleGetOnlinePicUrl }

/**
 * 在线源：解析播放地址，并返回**实际**音质（请求档位不被支持时会降级）。
 * 供下载链路记录 actualQuality —— 之前下载列表一律显示「下载设置里的音质」，
 * 请求 hires 但实际降级 flac 的场景会被错标成 hires（见 core/download.ts）。
 */
export const getMusicUrlWithQuality = async({
  musicInfo,
  quality,
  isRefresh,
}: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
}): Promise<{ url: string, quality: LX.Quality }> =>
  resolveOnlineMusicUrl({ musicInfo, quality, isRefresh })

// 「本地与下载」专用链路：不走自定义源管理，本地文件优先 + 内置平台直连回退
const getTaskTarget = (musicInfo: LX.Download.ListItem): localPlay.LocalPlayTarget => {
  const task = musicInfo as any
  const inner = task.musicInfo ?? task.metadata?.musicInfo
  return {
    name: inner?.name ?? '',
    singer: inner?.singer ?? '',
    filePath: task.filePath ?? task.metadata?.filePath ?? '',
    picUrl: inner?.meta?.picUrl ?? null,
    quality: 'quality' in musicInfo ? (musicInfo as any).quality : undefined,
  }
}

/**
 * 2026-10-18 离线模式：为在线歌曲查找本地已下载文件。
 * 匹配规则：优先按 ID 精确匹配，其次按歌名+歌手归一化匹配。
 * 返回存在的文件路径，找不到返回 null。
 */
const findOfflineLocalFile = async(song: LX.Music.MusicInfo): Promise<string | null> => {
  const normalize = (s: string) => (s || '').trim().toLowerCase()
  const songName = normalize(song.name)
  const songSinger = normalize(song.singer)
  for (const task of downloadState.tasks) {
    if (task.status !== 'completed' || !task.filePath) continue
    const ti = task.musicInfo
    if (!ti) continue
    // ID 精确匹配
    if (ti.id && song.id && ti.id === song.id) {
      if (await existsFile(task.filePath).catch(() => false)) return task.filePath
      continue
    }
    // 歌名+歌手匹配
    if (normalize(ti.name) === songName && normalize(ti.singer) === songSinger && songName) {
      if (await existsFile(task.filePath).catch(() => false)) return task.filePath
    }
  }
  return null
}

/**
 * 2026-10-18 离线模式：为在线歌曲查找本地封面。
 * 优先顺序：下载任务的 picUrl（本地文件）> 本地 picture/ 目录同名封面。
 */
const findOfflineLocalPic = async(song: LX.Music.MusicInfo): Promise<string | null> => {
  const normalize = (s: string) => (s || '').trim().toLowerCase()
  const songName = normalize(song.name)
  const songSinger = normalize(song.singer)
  const PIC_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif', 'avif']
  for (const task of downloadState.tasks) {
    if (task.status !== 'completed' || !task.filePath) continue
    const ti = task.musicInfo
    if (!ti) continue
    const matched = (ti.id && song.id && ti.id === song.id) ||
      (normalize(ti.name) === songName && normalize(ti.singer) === songSinger && songName)
    if (!matched) continue
    // 1. 任务自带的本地封面
    const taskPic = (ti.meta as any)?.picUrl
    if (taskPic && taskPic.startsWith('file://')) return taskPic
    // 2. 本地 picture/ 目录同名封面
    const audioDir = task.filePath.substring(0, task.filePath.lastIndexOf('/'))
    const parentDir = audioDir.substring(0, audioDir.lastIndexOf('/'))
    const base = task.fileName.replace(/\.[^/.]+$/, '')
    for (const dir of [audioDir, `${audioDir}/picture`, `${parentDir}/picture`]) {
      for (const ext of PIC_EXTS) {
        const p = `${dir}/${base}.${ext}`
        if (await existsFile(p).catch(() => false)) return `file://${p}`
      }
    }
    // 当前任务无封面，继续检查其他匹配的任务
  }
  return null
}

export const getMusicUrl = async({
  musicInfo,
  quality,
  isRefresh = false,
  onToggleSource,
  allowToggleSource,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  isRefresh?: boolean
  quality?: LX.Quality
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
}): Promise<string> => {
  webDAVLog.info('index.ts: getMusicUrl called', {
    isDownload: 'progress' in musicInfo,
    source: 'source' in musicInfo ? musicInfo.source : 'N/A',
    musicId: 'id' in musicInfo ? musicInfo.id : 'N/A',
  })
  if ('progress' in musicInfo) {
    return localPlay.getMusicUrl({ target: getTaskTarget(musicInfo), isRefresh })
  } else if (musicInfo.source == 'local') {
    if ('webdav' in musicInfo.meta && (musicInfo.meta as any).webdav) {
      webDAVLog.info('index.ts: Detected WebDAV music', { source: musicInfo.source, meta: JSON.stringify(musicInfo.meta) })
      return getLocalMusicUrl({ musicInfo, isRefresh, onToggleSource, allowToggleSource })
    }
    // 普通本地音乐：走本地播放接口（本地文件优先 + 内置平台回退）
    return localPlay.getMusicUrl({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: (musicInfo.meta as any).filePath,
        picUrl: (musicInfo.meta as any).picUrl ?? null,
      },
      isRefresh,
    })
  } else if (musicInfo.source == 'qs') {
    // 汽水音乐：本地无文件，走「其他源匹配」播放（用歌名+歌手在线搜索其他平台）
    // picUrl 传 null，强制跨平台匹配封面，避免汽水自身封面为空/不可用时卡在空图
    return localPlay.getMusicUrl({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: '',
        picUrl: null,
      },
      isRefresh,
    })
  } else {
    // 2026-10-18 离线模式：优先用本地已下载文件
    if (settingState.setting['player.offlineMode'] === true) {
      const localPath = await findOfflineLocalFile(musicInfo as LX.Music.MusicInfo)
      if (localPath) {
        webDAVLog.info('index.ts: 离线模式使用本地文件', { songId: (musicInfo as any).id, localPath })
        return localPath
      }
      throw new Error('离线模式：该歌曲未下载')
    }
    return getOnlineMusicUrl({ musicInfo, isRefresh, quality, onToggleSource, allowToggleSource })
  }
}

// 取链并返回「链接 + 实际音质」，供播放器判断能否走原生 FLAC 高精度路径。
// 参考 Q-1515/lx-music-mobile ios-adaptation：播放核心使用 getMusicUrlInfo，
// 本项目的本地/WebDAV/汽水链路没有音质回传，故回退为请求时指定的音质（缺省 null）。
export const getMusicUrlInfo = async({
  musicInfo,
  quality,
  isRefresh = false,
  onToggleSource,
  allowToggleSource,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  isRefresh?: boolean
  quality?: LX.Quality
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
}): Promise<{ url: string, quality: LX.Quality | null }> => {
  const url = await getMusicUrl({ musicInfo, quality, isRefresh, onToggleSource, allowToggleSource })
  return { url, quality: quality ?? null }
}

export const getPicPath = async({
  musicInfo,
  isRefresh = false,
  listId,
  onToggleSource,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  listId?: string | null
  isRefresh?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if ('progress' in musicInfo) {
    return localPlay.getPicUrl({ target: getTaskTarget(musicInfo), isRefresh })
  } else if (musicInfo.source == 'local') {
    if ('webdav' in musicInfo.meta && (musicInfo.meta as any).webdav) {
      return getLocalPicUrl({ musicInfo, isRefresh, listId, onToggleSource })
    }
    return localPlay.getPicUrl({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: (musicInfo.meta as any).filePath,
        picUrl: (musicInfo.meta as any).picUrl ?? null,
      },
      isRefresh,
    })
  } else if (musicInfo.source == 'qs') {
    // 汽水音乐封面：汽水自身通常不返回可用封面，直接走「其他源匹配」在线获取
    // （跨平台顺序：企鹅 → 网易 → 酷狗 → 酷我 → 咪咕），picUrl 传 null 强制回退匹配
    return localPlay.getPicUrl({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: '',
        picUrl: null,
      },
      isRefresh,
    })
  } else {
    // 2026-10-18 离线模式：优先用本地 picture/ 缓存的封面
    if (settingState.setting['player.offlineMode'] === true) {
      const localPic = await findOfflineLocalPic(musicInfo as LX.Music.MusicInfo)
      if (localPic) return localPic
      // 没有本地封面时返回空，不尝试在线获取
      return ''
    }
    return getOnlinePicUrl({ musicInfo, isRefresh, listId, onToggleSource })
  }
}

export const getLyricInfo = async({
  musicInfo,
  isRefresh = false,
  onToggleSource,
}: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  isRefresh?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  if ('progress' in musicInfo) {
    return localPlay.getLyricInfo({ target: getTaskTarget(musicInfo), isRefresh })
  } else if (musicInfo.source == 'local') {
    if ('webdav' in musicInfo.meta && (musicInfo.meta as any).webdav) {
      return getLocalLyricInfo({ musicInfo, isRefresh, onToggleSource })
    }
    return localPlay.getLyricInfo({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: (musicInfo.meta as any).filePath,
        picUrl: (musicInfo.meta as any).picUrl ?? null,
      },
      isRefresh,
    })
  } else if (musicInfo.source == 'qs') {
    // 汽水音乐歌词：走「其他源匹配」在线获取（跨平台顺序同上）
    return localPlay.getLyricInfo({
      target: {
        name: musicInfo.name,
        singer: musicInfo.singer,
        filePath: '',
        picUrl: null,
      },
      isRefresh,
    })
  } else {
    return getOnlineLyricInfo({ musicInfo, isRefresh, onToggleSource })
  }
}
