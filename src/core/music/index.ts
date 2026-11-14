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
import { findPictureForAudio, findLibraryPicture, coverBaseForSong, cacheCoverToLibrary, isPicCacheEnabled } from '@/utils/localLibrary'
import { readPic } from '@/utils/localMediaMetadata'

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
}): Promise<{ url: string, quality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline, source: LX.Source }> =>
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
  const nameMatched: Array<{ filePath: string, interval: string | null }> = []
  for (const task of downloadState.tasks) {
    if (task.status !== 'completed' || !task.filePath) continue
    const ti = task.musicInfo
    if (!ti) continue
    // ID 精确匹配
    if (ti.id && song.id && ti.id === song.id) {
      if (await existsFile(task.filePath).catch(() => false)) return task.filePath
      continue
    }
    // 歌名+歌手匹配（中-8：歌手同为空不算命中——空歌手同名歌会互相误配；
    // 多个命中时优先时长一致的，避免 Live/重录版被当成本歌离线播放）
    if (songSinger && normalize(ti.singer) === songSinger && normalize(ti.name) === songName && songName) {
      nameMatched.push({ filePath: task.filePath, interval: ti.interval })
    }
  }
  if (nameMatched.length) {
    const byInterval = song.interval
      ? nameMatched.find(m => m.interval === song.interval)
      : undefined
    const ordered = byInterval ? [byInterval, ...nameMatched.filter(m => m !== byInterval)] : nameMatched
    for (const m of ordered) {
      if (await existsFile(m.filePath).catch(() => false)) return m.filePath
    }
  }
  return null
}

/**
 * 2026-11-13 离线分区展示：同步版的「是否已下载」判定，供列表分区用。
 * 匹配口径与 findOfflineLocalFile 一致（ID 精确匹配优先、歌名+歌手归一化
 * 匹配兜底，歌手为空不走歌名匹配），仅两处为展示做了取舍：不做 existsFile
 * 校验（分区是同步计算，逐首异步验文件不可行）；同名多命中时不按时长择优
 * （任一命中即算已下载）。文件已被外部删除的过期任务会误判为已下载——
 * 点播时仍走 findOfflineLocalFile 验文件、失败有 toast，不会播错歌。
 * 查找表一次建成、单首 O(1) 判定，千首列表也不会卡。
 */
export interface DownloadedLookup {
  ids: Set<string>
  nameSinger: Set<string>
}
export const buildDownloadedLookup = (): DownloadedLookup => {
  const ids = new Set<string>()
  const nameSinger = new Set<string>()
  const normalize = (s: string) => (s || '').trim().toLowerCase()
  for (const task of downloadState.tasks) {
    if (task.status !== 'completed' || !task.filePath) continue
    const ti = task.musicInfo
    if (!ti) continue
    if (ti.id) ids.add(ti.id)
    const n = normalize(ti.name)
    const s = normalize(ti.singer)
    if (n && s) nameSinger.add(`${n}\n${s}`)
  }
  return { ids, nameSinger }
}
export const isSongDownloaded = (song: LX.Music.MusicInfo, lookup: DownloadedLookup): boolean => {
  if (song.id && lookup.ids.has(song.id)) return true
  const n = (song.name || '').trim().toLowerCase()
  const s = (song.singer || '').trim().toLowerCase()
  return !!n && !!s && lookup.nameSinger.has(`${n}\n${s}`)
}

/**
 * 2026-10-22 封面缓存全局化：为在线歌曲查找本地已缓存封面（不限离线模式）。
 * 优先顺序：匹配的下载任务自带本地封面 > 任务音频同名 picture/ 封面 >
 * 任务音频内嵌封面 > 按下载文件名模板（歌名 - 歌手）在本地库 picture/ 里找。
 */
const findLocalCachedPic = async(song: LX.Music.MusicInfo): Promise<string | null> => {
  const normalize = (s: string) => (s || '').trim().toLowerCase()
  const songName = normalize(song.name)
  const songSinger = normalize(song.singer)
  for (const task of downloadState.tasks) {
    if (task.status !== 'completed' || !task.filePath) continue
    const ti = task.musicInfo
    if (!ti) continue
    const matched = (ti.id && song.id && ti.id === song.id) ||
      // 中-8：同 findOfflineLocalFile 口径，歌手为空不走歌名匹配
      (songSinger !== '' && normalize(ti.name) === songName && normalize(ti.singer) === songSinger && songName)
    if (!matched) continue
    // 1. 任务自带的本地封面
    const taskPic = (ti.meta as any)?.picUrl
    if (taskPic && taskPic.startsWith('file://')) return taskPic
    // 2. 任务音频同名 picture/ 封面（music/ ↔ picture/ 等结构统一查找）
    const sidecar = await findPictureForAudio(task.filePath).catch(() => null)
    if (sidecar) return `file://${sidecar}`
    // 3. 任务音频内嵌封面（2026-11-13，与播放链路 localPlay.getPicUrl 第 1 步
    //    对齐）：2026-10-22 之前下载的歌曲只有内嵌封面、没有 picture/ 旁路
    //    文件，列表此前从不读内嵌，离线时显示 LX 占位图。列表缺内嵌而播放
    //    链路（任务/本地分支）有内嵌是不对称的代码事实；在线歌曲从歌单点播
    //    时播放与列表走同一条 findLocalCachedPic，不要把“播放有封面”一概
    //    归因于此（迷你播放器封面也可能是在线时段解析后残留的）。
    //    旁路文件优先于内嵌（existsFile 便宜、原生提取相对贵）；音频文件
    //    不存在时不调原生提取（与 localPlay 同款守卫）。
    if (await existsFile(task.filePath).catch(() => false)) {
      const embedded = await readPic(task.filePath).catch(() => null)
      if (embedded) return embedded
    }
    // 当前任务无封面，继续检查其他匹配的任务
  }
  // 4. 在线时缓存到 picture/ 的封面（按模板基名）
  const libraryPic = await findLibraryPicture(coverBaseForSong(song.name, song.singer)).catch(() => null)
  if (libraryPic) return `file://${libraryPic}`
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
    // 2026-11-12：离线模式对 qs 同样生效——此前 qs 分支绕过了离线判断，
    // 离线模式下汽水歌曲仍会联网取链，与其他源行为不一致
    if (settingState.setting['player.offlineMode'] === true) {
      const localPath = await findOfflineLocalFile(musicInfo as LX.Music.MusicInfo)
      if (localPath) return localPath
      throw new Error('离线模式：该歌曲未下载')
    }
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

// 取链并返回「链接 + 实际音质 + 实际平台」，供播放器判断能否走原生 FLAC
// 高精度路径、以及详情页展示失败策略换源/换音质后的实际值。
// 参考 Q-1515/lx-music-mobile ios-adaptation：播放核心使用 getMusicUrlInfo，
// 本项目的本地/WebDAV/汽水链路没有音质回传，故回退为请求时指定的音质（缺省 null）。
// 实际平台取 resolveMusicUrl 回传的 source（换源成功时即目标平台；缓存命中时
// 取缓存里记的平台——换源 URL 会存到原歌名下，musicInfo.source 会误报）；
// 非在线路径不换源，回传歌曲自身平台。
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
}): Promise<{ url: string, quality: LX.Quality | null, source: LX.Source | null }> => {
  // 中-9：在线歌曲直接走 resolveMusicUrl 拿实际音质——此前用 getMusicUrl 取到
  // 链接后把请求档位原样回显，实际降级时播放器仍按高档位处理（原生 FLAC
  // 高精度路径误判）；未指定档位时恒 null、高精度永不启用。
  const isOnlineSong = !('progress' in musicInfo) && musicInfo.source != 'local' && musicInfo.source != 'qs'
  if (isOnlineSong && settingState.setting['player.offlineMode'] !== true) {
    const resolved = await resolveOnlineMusicUrl({
      musicInfo: musicInfo as LX.Music.MusicInfoOnline,
      quality,
      isRefresh,
      onToggleSource,
      allowToggleSource,
    })
    // M-1：用 resolveMusicUrl 回传的 source，不用 musicInfo.source——缓存命中时
    // musicInfo 是请求的那首歌，而 URL 可能是历史上换源后存下的别家 URL。
    return { url: resolved.url, quality: resolved.quality, source: resolved.source }
  }
  const url = await getMusicUrl({ musicInfo, quality, isRefresh, onToggleSource, allowToggleSource })
  const originalSource: LX.Source | null = 'progress' in musicInfo
    ? (musicInfo.metadata?.musicInfo?.source ?? null)
    : musicInfo.source
  // 2026-11-14 下载项播放时显示实际下载平台：任务换源下载后 metadata.actualSource
  // 与原平台不同，返回实际平台，setResource 写入 playerState.actualSource 后详情页
  // 徽章即显示「原 → 实际」；未换源/旧任务无此字段时回退原平台，行为与原来一致。
  // 注意：这里只改返回的 source（供徽章展示），不改 url/歌词/封面取链——它们仍按
  // 原平台 musicInfo 走。
  const resolvedSource: LX.Source | null = 'progress' in musicInfo
    ? (musicInfo.metadata?.actualSource ?? originalSource)
    : originalSource
  return { url, quality: quality ?? null, source: resolvedSource }
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
    // 2-9(b)：下载任务分支也传 offlineOnly——离线时封面只读本地
    return localPlay.getPicUrl({ target: getTaskTarget(musicInfo), isRefresh, offlineOnly: settingState.setting['player.offlineMode'] === true })
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
      // 2-9(b)：本地源分支也传 offlineOnly——离线时封面只读本地
      offlineOnly: settingState.setting['player.offlineMode'] === true,
    })
  } else if (musicInfo.source == 'qs') {
    // 2026-11-12：离线模式下 qs 封面也只读本地 picture/ 缓存，不再跨平台联网匹配
    if (settingState.setting['player.offlineMode'] === true) {
      const localPic = await findLocalCachedPic(musicInfo as LX.Music.MusicInfo)
      return localPic ?? ''
    }
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
    // 2026-10-22 封面缓存全局化：本地 picture/ 有缓存先用缓存（不限离线模式），
    // 不再出现「本地有缓存但控件仍去加载在线地址」
    // 2-9(c)：手动刷新（isRefresh）时跳过本地缓存命中、走在线刷新——此前本地有缓存
    // 就直接返回，刷新恒无效；离线时仍返回本地缓存（无缓存才返回空），离线刷新不清空封面
    const localPic = await findLocalCachedPic(musicInfo as LX.Music.MusicInfo)
    if (localPic && !isRefresh) return localPic
    if (settingState.setting['player.offlineMode'] === true) {
      // 离线模式没有本地封面时返回空，不尝试在线获取
      return localPic ?? ''
    }
    const url = await getOnlinePicUrl({ musicInfo, isRefresh, listId, onToggleSource })
    // 歌词/封面缓存策略（2026-11-12）：在线拿到的封面在封面缓存开启时落盘
    // picture/，并直接返回本地路径，保证本次显示与后续所有控件都走本地缓存；
    // 关闭时只返回在线地址、内存显示一次，不落盘
    if (url && url.startsWith('http') && isPicCacheEnabled()) {
      const cached = await cacheCoverToLibrary(coverBaseForSong(musicInfo.name, musicInfo.singer), url).catch(() => null)
      if (cached) return cached
    }
    return url
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
    // 2-9(b)：下载任务分支也传 offlineOnly——离线时歌词只读本地
    return localPlay.getLyricInfo({ target: getTaskTarget(musicInfo), isRefresh, offlineOnly: settingState.setting['player.offlineMode'] === true })
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
      // 2-9(b)：本地源分支也传 offlineOnly——离线时歌词只读本地
      offlineOnly: settingState.setting['player.offlineMode'] === true,
    })
  } else if (musicInfo.source == 'qs') {
    // 2026-11-12：离线模式下 qs 歌词也只读本地（匹配到的已下载文件的内嵌/同名 lrc），
    // 不再跨平台联网取词
    if (settingState.setting['player.offlineMode'] === true) {
      const localPath = await findOfflineLocalFile(musicInfo as LX.Music.MusicInfo)
      return localPlay.getLyricInfo({
        target: {
          name: musicInfo.name,
          singer: musicInfo.singer,
          filePath: localPath ?? '',
          picUrl: null,
        },
        isRefresh,
        offlineOnly: true,
      })
    }
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
    // 低-31：离线模式下歌词也只走本地——此前 URL/封面都拦了、唯独歌词照常
    // 联网取词+换源搜索，与离线语义不一致
    if (settingState.setting['player.offlineMode'] === true) {
      const localPath = await findOfflineLocalFile(musicInfo as LX.Music.MusicInfo)
      return localPlay.getLyricInfo({
        target: {
          name: musicInfo.name,
          singer: musicInfo.singer,
          filePath: localPath ?? '',
          picUrl: null,
        },
        isRefresh,
        offlineOnly: true,
      })
    }
    return getOnlineLyricInfo({ musicInfo, isRefresh, onToggleSource })
  }
}
