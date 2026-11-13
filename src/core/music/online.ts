import { saveLyric, saveMusicUrl, getMusicUrl as getStoreMusicUrl, getCachedMusicUrlWithSource as getStoreMusicUrlWithSource } from '@/utils/data'
import { cacheLyricToLibrary, coverBaseForSong } from '@/utils/localLibrary'
import { mergeLyrics } from '@/screens/Home/Views/Mylist/MusicList/download/lrcTool'
import {
  setLastTryQuality,
  buildLyricInfo,
  getPlayQuality,
  handleGetOnlineLyricInfo,
  handleGetOnlineMusicUrl,
  handleGetOnlinePicUrl,
  getCachedLyricInfo, QUALITY_RANK,
} from './utils'
import { updateListMusics } from '@/core/list'
import settingState from '@/store/setting/state'

import wySdk from '@/utils/musicSdk/wy'

import { fetchAndApplyDetailedQuality } from '@/utils/musicSdk/wy/musicDetail.js'
import userState from '@/store/user/state'

/* export const setMusicUrl = ({ musicInfo, type, url }: {
  musicInfo: LX.Music.MusicInfo
  type: LX.Quality
  url: string
}) => {
  saveMusicUrl(musicInfo, type, url)
}

export const setPic = (datas: {
  listId: string
  musicInfo: LX.Music.MusicInfo
  url: string
}) => {
  datas.musicInfo.img = datas.url
  updateMusicInfo({
    listId: datas.listId,
    id: datas.musicInfo.songmid,
    data: { img: datas.url },
    musicInfo: datas.musicInfo,
  })
}
 */

// 网易云 cookie 接口返回的实际档位（standard/higher/exhigh/lossless/hires/jymaster，
// 见 utils/musicSdk/wy/api-cookie.js）→ LX 音质标识。未收录的档位（jyeffect/sky 等）
// 回退为请求音质，不做猜测。
const WY_LEVEL_TO_QUALITY: Record<string, LX.Quality> = {
  standard: '128k',
  higher: '192k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'hires',
  jymaster: 'master',
}

export const getMusicUrl = async(options: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  silent?: boolean
}): Promise<string> => (await resolveMusicUrl(options)).url

/**
 * 解析播放地址，并同时报出**实际**拿到的音质（歌曲不支持请求档位时会降级）
 * 与**实际**取链平台（失败策略换源成功时为目标平台；缓存命中时取缓存里记
 * 的平台——换源 URL 会存到原歌名下，不记平台会误报原平台，见 M-1）。
 * 播放链路只关心 url（用 getMusicUrl）；下载链路需要把实际音质记下来展示
 * （见 core/download.ts 的 actualQuality：请求 hires、实际降级 flac 时列表要显示 flac）。
 */
export const resolveMusicUrl = async({
  musicInfo,
  quality,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
  silent = false,
}: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  silent?: boolean
}): Promise<{ url: string, quality: LX.Quality, musicInfo: LX.Music.MusicInfoOnline, source: LX.Source }> => {
  // if (!musicInfo._types[type]) {
  //   if (!(musicInfo.source == 'kw' && type == '128k')) throw new Error('该歌曲没有可播放的音频')

  //   // return Promise.reject(new Error('该歌曲没有可播放的音频'))
  // }

  let currentMusicInfo = musicInfo
  const preferredQuality = settingState.setting['player.playQuality']

  const isWySource = currentMusicInfo.source === 'wy'
  const hasFullDetails = currentMusicInfo.meta._full
  // P2: 生产环境不打印全量对象，__DEV__ 才打
  if (!silent && typeof __DEV__ !== 'undefined' && __DEV__) console.log('播放：currentMusicInfo:', currentMusicInfo)

  if (isWySource && !hasFullDetails) {
    // P1（2026-10-06）：_qualitys 为 undefined 时 Object.keys 会抛 TypeError，
    // 本意是"音质未知则拉详情"，加守卫直接走详情
    if (!currentMusicInfo.meta._qualitys) {
      if (!silent) console.log('音质信息缺失，获取音质详情')
      currentMusicInfo = await fetchAndApplyDetailedQuality(currentMusicInfo, 0, silent)
    } else {
      const availableQualities = Object.keys(currentMusicInfo.meta._qualitys) as LX.Quality[]
      const preferredQualityIndex = QUALITY_RANK.indexOf(preferredQuality)
      const qualityIndexes = availableQualities.map(q => QUALITY_RANK.indexOf(q)).filter(idx => idx !== -1)
      const maxAvailableQualityIndex = qualityIndexes.length ? Math.min(...qualityIndexes) : Infinity

      if (preferredQualityIndex < maxAvailableQualityIndex) {
        if (!silent) console.log('用户想要的音质比当前已知的最好音质还要高，获取音质详情')
        currentMusicInfo = await fetchAndApplyDetailedQuality(currentMusicInfo, 0, silent)
      } else {
        if (!silent) console.log('用户想要的音质比当前已知的最好音质还要低，无需获取音质详情')
        void fetchAndApplyDetailedQuality(currentMusicInfo, 0, silent)
      }
    }
  }

  const targetQuality = quality ?? getPlayQuality(preferredQuality, currentMusicInfo)

  // 如果不是刷新请求，先检查缓存
  // M-1：命中时返回缓存里记的实际平台——该条目可能是历史上换源后存下的
  // 别家 URL；旧格式条目（无 source）回退到请求歌自身平台。
  if (!isRefresh) {
    const cached = await getStoreMusicUrlWithSource(currentMusicInfo, targetQuality)
    if (cached.url) {
      setLastTryQuality(currentMusicInfo.id, targetQuality)
      return { url: cached.url, quality: targetQuality, musicInfo: currentMusicInfo, source: cached.source ?? currentMusicInfo.source }
    }
  }

  const highQualityLevels: LX.Quality[] = ['flac', 'hires', 'master', 'atmos', 'atmos_plus']

  const isVipUser = userState.wy_vip_type !== 0
  const isVipSong = currentMusicInfo.meta.fee === 1
  const isHighQuality = highQualityLevels.includes(targetQuality)

  const preferApi = !isWySource || (!isVipUser && (isVipSong || isHighQuality))

  if (!silent) console.log('vip:' + userState.wy_vip_type)
  if (preferApi) {
    try {
      if (!silent) console.log('Attempting to get music URL via custom API')
      const result = await handleGetOnlineMusicUrl({
        musicInfo: currentMusicInfo,
        quality: targetQuality,
        onToggleSource,
        isRefresh,
        allowToggleSource,
      })
      if (!silent) console.log('Custom API request succeeded', result)
      if (!silent) console.log('### [WHITEBOX_API_URL] 异步 URL 真正就绪 ###', { title: currentMusicInfo.name, songId: currentMusicInfo.id, url: result.url })
      // 2-10：按兜底路径对齐缓存同步——换源歌曲自己的条目也要写（否则下次直接播它时
      // 缓存未命中、重复取链）；缓存命中时不重复写盘；wy 详情重取导致 id 变化时原条目也同步
      // M-1：三处存点都带实际平台——同一条 URL 存到哪个键下，它的平台就是
      // 实际取链平台（result.source 优先于 musicInfo.source：换源候选的缓存
      // 命中可能来自二阶换源，musicInfo.source 此时不是 URL 的真实平台）。
      const actualSource = result.source ?? result.musicInfo.source
      if (result.musicInfo.id != currentMusicInfo.id && !result.isFromCache) void saveMusicUrl(result.musicInfo, result.quality, result.url, actualSource)
      void saveMusicUrl(currentMusicInfo, result.quality, result.url, actualSource)
      setLastTryQuality(currentMusicInfo.id, result.quality)
      if (currentMusicInfo.id !== musicInfo.id) void saveMusicUrl(musicInfo, result.quality, result.url, actualSource)
      return { url: result.url, quality: result.quality ?? targetQuality, musicInfo: result.musicInfo, source: actualSource }
    } catch (apiError) {
      if (!silent) console.log('Custom API request failed', apiError)
      throw apiError
    }
  }

  if (musicInfo.source == 'wy' && settingState.setting['common.wy_cookie']) {
    try {
      const result: any = await wySdk.cookie.getMusicUrl(currentMusicInfo, targetQuality).promise
      const url: string | undefined = result?.url
      if (url) {
        // 中-10：按实际档位存缓存与上报——此前按请求档位存，低码率 URL 被当
        // 高音质长期复用（播放器按 hires 走高精度路径、降级逻辑也被误导）。
        // 首次多一次取链，换来缓存里的音质永远真实。
        const actualQuality = WY_LEVEL_TO_QUALITY[result?.level] ?? targetQuality
        void saveMusicUrl(currentMusicInfo, actualQuality, url, currentMusicInfo.source)
        setLastTryQuality(currentMusicInfo.id, actualQuality)
        if (currentMusicInfo.id !== musicInfo.id) void saveMusicUrl(musicInfo, actualQuality, url, currentMusicInfo.source)
        return { url, quality: actualQuality, musicInfo: currentMusicInfo, source: currentMusicInfo.source }
      }
    } catch (error) {
      if (!silent) console.log('Get music url with cookie failed, fallback to custom api', error)
    }
  }

  return handleGetOnlineMusicUrl({
    musicInfo: currentMusicInfo,
    quality: targetQuality,
    onToggleSource,
    isRefresh,
    allowToggleSource,
  }).then(({ url, quality: resolvedQuality, musicInfo: targetMusicInfo, isFromCache, source: resolvedSource }) => {
    const actualSource = resolvedSource ?? targetMusicInfo.source
    if (targetMusicInfo.id != currentMusicInfo.id && !isFromCache) { void saveMusicUrl(targetMusicInfo, resolvedQuality, url, actualSource) }
    void saveMusicUrl(currentMusicInfo, resolvedQuality, url, actualSource)
    setLastTryQuality(currentMusicInfo.id, resolvedQuality)
    if (currentMusicInfo.id !== musicInfo.id) void saveMusicUrl(musicInfo, resolvedQuality, url, actualSource)
    return { url, quality: resolvedQuality ?? targetQuality, musicInfo: targetMusicInfo, source: actualSource }
  })
}

export const getPicUrl = async({
  musicInfo,
  listId,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoOnline
  listId?: string | null
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if (musicInfo.meta.picUrl && !isRefresh) return musicInfo.meta.picUrl
  return handleGetOnlinePicUrl({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(
    ({ url }) => {
      // picRequest = null
      if (listId) {
        musicInfo.meta.picUrl = url
        void updateListMusics([{ id: listId, musicInfo }])
      }
      // savePic({ musicInfo, url, listId })
      return url
    },
  )
}
export const getLyricInfo = async({
  musicInfo,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoOnline
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  let cachedLyricInfo: LX.Music.LyricInfo | null = null
  if (!isRefresh) {
    cachedLyricInfo = await getCachedLyricInfo(musicInfo)
    if (cachedLyricInfo) {
      const hasTranslation = !!(cachedLyricInfo.tlyric && cachedLyricInfo.tlyric.trim().length > 0)
      if (hasTranslation || musicInfo.source !== 'tx') {
        return buildLyricInfo(cachedLyricInfo)
      }
    }
  }
  // lrcRequest = music[musicInfo.source].getLyric(musicInfo)
  return handleGetOnlineLyricInfo({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(
    async({ lyricInfo, musicInfo: targetMusicInfo, isFromCache }) => {
      if (isFromCache) return buildLyricInfo(lyricInfo)

      const apiHasTranslation = !!(lyricInfo.tlyric && lyricInfo.tlyric.trim().length > 0)
      if (!apiHasTranslation && cachedLyricInfo?.lyric) {
        const merged = { ...lyricInfo, lyric: lyricInfo.lyric || cachedLyricInfo.lyric }
        if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, merged)
        else void saveLyric(targetMusicInfo, merged)
        // 歌词缓存（2026-11-12）：刚从网络拿到的歌词落盘 lrc/（与封面缓存对称），
        // 写的是 buildLyricInfo 转换前的原始文本，读回时再走统一转换；缓存开关
        // 关闭时内部直接返回、不写盘。基名按请求的歌（musicInfo）取，不按跨平台
        // 匹配到的目标歌取，保证与该歌下载后的音频同名对应
        void cacheLyricToLibrary(coverBaseForSong(musicInfo.name, musicInfo.singer), mergeLyrics(merged.lyric, merged.tlyric, merged.rlyric))
        return buildLyricInfo(merged)
      }

      if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, lyricInfo)
      else void saveLyric(targetMusicInfo, lyricInfo)

      void cacheLyricToLibrary(coverBaseForSong(musicInfo.name, musicInfo.singer), mergeLyrics(lyricInfo.lyric, lyricInfo.tlyric, lyricInfo.rlyric))

      return buildLyricInfo(lyricInfo)
    },
  ).catch(async(err) => {
    if (cachedLyricInfo?.lyric) {
      return buildLyricInfo(cachedLyricInfo)
    }
    throw err
  })
}
