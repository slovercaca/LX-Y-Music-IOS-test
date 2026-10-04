import TrackPlayer from 'react-native-track-player'
import { Platform } from 'react-native'
import settingState from '@/store/setting/state'
import { acquireLifecycleGuard } from './lifecycleGuard'
import {
  getNativeFlacTrackId,
  resetNativeFlacPlayback,
  shouldUseNativeFlacPlayer,
  startNativeFlacPlayback,
} from '../nativeFlac'
import {
  clearTracks,
  ensureCurrentTrackMetadata,
  loadTrackPlayerResource,
} from '../trackPlayerCore'

const resolveShouldAutoStart = (currentTrackIndex: number | null) => {
  if (currentTrackIndex != null) return true
  if (!global.lx.restorePlayInfo) return true
  global.lx.restorePlayInfo = null
  return false
}

// E2 修复：换歌装载代际令牌。playList.playMusic 的 actionId 串行只覆盖主入口，
// reloadConfig 恢复、错误恢复等旁路仍可与主流程交错，导致旧的 in-flight 装载
// 与新装载互相覆盖：播错歌、元数据错配、甚至双驱动同时发声。
// 每次装载取一个单调递增的代际号，每个 await 之后检查是否过期，过期直接丢弃，
// 只有最新一代能走完全流程、写元数据。
let loadGeneration = 0

export const loadPlaybackResource = async({
  musicInfo,
  url,
  time,
  quality,
}: {
  musicInfo: LX.Player.PlayMusic
  url: string
  time: number
  quality?: LX.Quality | null
}) => {
  const generation = ++loadGeneration
  const isStale = () => generation !== loadGeneration

  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  if (isStale()) return
  const shouldAutoStart = resolveShouldAutoStart(currentTrackIndex)

  if (Platform.OS == 'ios' && await shouldUseNativeFlacPlayer(musicInfo, url, quality)) {
    if (isStale()) return
    // M2 修复：抑制窗口改成引用计数守卫（acquireLifecycleGuard）。
    // 原来是裸布尔量，不支持嵌套——并发 load 时旧代际的 finally 会提前关闭
    // 新代际的保护窗口，导致陈旧 trackPlayer 事件泄漏进总线。
    const releaseLifecycleGuard = acquireLifecycleGuard()
    try {
      try {
        await TrackPlayer.reset().catch(async() => {
          await TrackPlayer.stop().catch(() => {})
        })
        if (isStale()) return
        clearTracks()
        const playbackInfo = await startNativeFlacPlayback(musicInfo, url, time, shouldAutoStart, quality ?? null)
        // 过期时直接返回、不做任何清理：最新一代在启动自己的播放前一定会先
        // reset/clear（见下方的 AVPlayer 路径与 startNativeFlacPlayback 的杀旧实例），
        // 这里若擅自 reset 会误杀新一代刚建好的播放。
        if (isStale()) return
        global.lx.playerTrackId = getNativeFlacTrackId()
        ensureCurrentTrackMetadata({
          title: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.name : musicInfo.name) ?? 'Unknow',
          artist: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.singer : musicInfo.singer) ?? 'Unknow',
          album: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.meta.albumName : musicInfo.meta.albumName) ?? undefined,
          artwork: 'progress' in musicInfo
            ? (typeof musicInfo.metadata.musicInfo.meta.picUrl == 'string' ? musicInfo.metadata.musicInfo.meta.picUrl : undefined)
            : (typeof musicInfo.meta.picUrl == 'string' ? musicInfo.meta.picUrl : undefined),
          duration: playbackInfo.duration,
          elapsedTime: playbackInfo.position,
          playbackRate: settingState.setting['player.playbackRate'],
        })
        return
      } catch (err) {
        // 过期时不回退 AVPlayer：最新一代会走自己的完整流程，这里回退只会添乱。
        if (isStale()) return
        // nativeFlac 打开失败（本地文件被禁用 / 远程流打开失败 / 原生桥不可用）：
        // 回退 AVPlayer 播放同一资源——AVPlayer 承载所有音质，是全音质兜底路径，
        // 不让高音质 + 开关开时的 native 故障演变成整次播放失败。此时 TrackPlayer
        // 已被 reset、tracks 已清空，正好是 loadTrackPlayerResource 的标准前置
        // （正常 AVPlayer 换歌同样先 reset/clearTracks 再装载），从干净状态重建即可。
        await resetNativeFlacPlayback().catch(() => {})
        console.warn('nativeFlac open failed, fallback to AVPlayer:', err instanceof Error ? err.message : err)
      }
    } finally {
      releaseLifecycleGuard()
    }
  }

  if (isStale()) return
  if (Platform.OS == 'ios') {
    await resetNativeFlacPlayback().catch(() => {})
    if (isStale()) return
  }

  const track = await loadTrackPlayerResource(musicInfo, url, time, shouldAutoStart)
  if (isStale()) return
  ensureCurrentTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: typeof track.artwork == 'string' ? track.artwork : undefined,
    duration: track.duration,
    elapsedTime: time,
  })
}

