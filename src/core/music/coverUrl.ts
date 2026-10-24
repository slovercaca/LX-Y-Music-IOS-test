import { getPicPath } from './index'
import { getCachedQsCover, fetchQsCover } from './qsCover'

/**
 * 列表项封面动态获取。
 *
 * 问题背景：cookie 登录平台歌单、WebDAV 同步、备份导入的歌曲，其 meta.picUrl 常为空，
 * 列表直接用静态 meta.picUrl 就显示无封面；而播放时 player.ts 会调 getPicPath 动态
 * 获取（在线接口/本地内嵌/网盘封面），所以「播放有封面、列表无封面」。
 *
 * 这里把同一套动态获取逻辑下沉到列表层：meta.picUrl 为空时按需调用 getPicPath
 * （内部已按 source 分发：在线 / webdav / 本地 / qs），结果按「歌名|歌手」缓存，
 * 并带并发上限，避免列表逐行触发请求打爆接口。
 */
const coverCache = new Map<string, string>()
const coverInflight = new Map<string, Promise<string>>()

const MAX_CONCURRENT = 4
let activeCount = 0
const taskQueue: Array<() => void> = []

const runWithLimit = async(fn: () => Promise<string>): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const execute = (): void => {
      activeCount++
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeCount--
          const next = taskQueue.shift()
          if (next) next()
        })
    }
    if (activeCount < MAX_CONCURRENT) execute()
    else taskQueue.push(execute)
  })
}

interface CoverSong { source: string, name: string, singer: string, albumName?: string, songId?: string, id?: string, meta?: { albumName?: string, songId?: string | number } }

const keyOf = (song: CoverSong): string =>
  // P2: key 加入 albumName/songId，同名同歌手多版本不再串封面
  // 中-14：转换后的歌曲这两字段在 meta 下，只读顶层恒为 undefined、缓存键退化成
  // 「源|歌名|歌手」→ 不同专辑/版本共用第一个缓存封面串图。两层都读。
  `${song.source}|${song.name}|${song.singer}|${song.albumName ?? song.meta?.albumName ?? ''}|${song.songId ?? song.meta?.songId ?? song.id ?? ''}`

export const getCachedCoverUrl = (song: CoverSong): string => {
  if (song.source === 'qs') return getCachedQsCover(song as LX.Music.MusicInfoOnline)
  return coverCache.get(keyOf(song)) ?? ''
}

export const fetchCoverUrl = async(song: CoverSong): Promise<string> => {
  // qs 源沿用既有跨平台匹配逻辑（含其独立缓存）
  if (song.source === 'qs') return fetchQsCover(song as LX.Music.MusicInfoOnline)

  const key = keyOf(song)
  const cached = coverCache.get(key)
  if (cached) return cached
  const inflight = coverInflight.get(key)
  if (inflight) return inflight

  const task = runWithLimit(async() =>
    // 中-7：取封面无超时——任意 4 个请求挂起（慢接口/黑洞地址）就会把并发
    // 队列堵死、全 App 封面永久排队。照 qsCover 的 12s 口径兜底，超时按无封面处理。
    Promise.race([
      getPicPath({ musicInfo: song as LX.Music.MusicInfo, isRefresh: false }),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('') }, 12000) }),
    ]),
  )
    .then((url) => {
      if (url) coverCache.set(key, url)
      return url
    })
    .catch(() => '')
    .finally(() => {
      coverInflight.delete(key)
    })
  coverInflight.set(key, task)
  return task
}
