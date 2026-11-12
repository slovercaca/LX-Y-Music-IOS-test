import TrackPlayer from 'react-native-track-player'
import { Platform } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'
import { updateMetaData } from './playList'
import { initUnifiedPlayerEngine, onUnifiedPlayerEvent } from './engine'
import { getNativeFlacTrackId, setNativeFlacRate, setNativeFlacVolume } from './nativeFlac'
import { getPosition, getPositionStamped, elapsedSnapshotFields, isEmpty, isTempId, setStop } from './utils'
import { exitApp } from '@/core/common'
import { playNext, setMusicUrl } from '@/core/player/player'
import { QUALITY_RANK, getLastTryQuality, removeMusicUrl } from '@/core/music/utils'
import { getFailureStrategyConfig, getNextStrategyQuality } from '@/core/music/failureStrategy'
import { setStatusText } from '@/core/player/playStatus'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { playNowPlaying, pauseNowPlaying } from '@/utils/nativeModules/nowPlaying'
import { toast } from '@/utils/tools'
import { startPreload, stopPreload } from '@/core/player/preload'
import { savePlayInfo } from '@/utils/data'

let isInitialized = false

const handleExitApp = async(reason: string) => {
  global.lx.isPlayedStop = false
  // 对齐上游 usePlaybackPersistence 的 beforeunload 兜底：退出前把当前进度落盘。
  // time 按开关取值（关闭「记住播放进度」存 0，下次从头播），与常规保存一致
  if (playerState.playMusicInfo.musicInfo && playerState.playMusicInfo.listId) {
    void savePlayInfo({
      time: settingState.setting['player.isSavePlayTime'] ? playerState.progress.nowPlayTime : 0,
      maxTime: playerState.progress.maxPlayTime,
      listId: playerState.playMusicInfo.listId,
      index: playerState.playInfo.playIndex,
    }).catch(() => {})
  }
  exitApp(reason)
}

export const initUnifiedPlayerController = () => {
  if (isInitialized) return
  initUnifiedPlayerEngine()

  let retryNum = 0
  let prevTimeoutId: string | null = null
  let loadingTimeout: number | null = null
  let delayNextTimeout: number | null = null
  // S-5：handleControllerError 在途标志——2-4A 在函数内加了 await getPosition() 后，
  // 两次 error 事件在约 20ms 内到达会并发重入：双双通过过期守卫、各调一次
  // setMusicUrl、② 分支各 retryNum++ 一次，一次报错耗尽两次刷新额度
  let handlingError = false


  const clearLoadingTimeout = () => {
    if (!loadingTimeout) return
    BackgroundTimer.clearTimeout(loadingTimeout)
    loadingTimeout = null
  }

  const startLoadingTimeout = () => {
    // 2026-10-22：看门狗与 autoSkipOnError 解耦——关闭自动跳过时也要启动，
    // 否则加载可无限期卡在「缓冲中」且用户无从恢复；只是超时后不自动跳歌，
    // 改为明确提示用户手动重试。
    clearLoadingTimeout()
    loadingTimeout = BackgroundTimer.setTimeout(() => {
      if (!settingState.setting['player.autoSkipOnError']) {
        // 2-4B：关闭自动跳过时只写文案不重试是死路——停掉卡死引擎并清 playerTrackId，
        // 播放键的 play() 见 trackId 为空才会重取链重试；setStop 在 iOS TrackPlayer
        // 路径下不清 playerTrackId（仅 nativeFlac 路径清），需手动清
        if (!isEmpty()) void setStop()
        global.lx.playerTrackId = ''
        setStatusText('加载超时，点播放键重试')
        return
      }
      if (prevTimeoutId == playerState.musicInfo.id) {
        prevTimeoutId = null
        void playNext(true)
      } else {
        prevTimeoutId = playerState.musicInfo.id
        if (playerState.playMusicInfo.musicInfo) setMusicUrl(playerState.playMusicInfo.musicInfo, true)
      }
    }, 25000)
  }

  const clearDelayNextTimeout = () => {
    if (!delayNextTimeout) return
    BackgroundTimer.clearTimeout(delayNextTimeout)
    delayNextTimeout = null
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    delayNextTimeout = BackgroundTimer.setTimeout(() => {
      if (global.lx.isPlayedStop) {
        setStatusText('')
        return
      }
      void playNext(true)
    }, 5000)
  }

  const resetRecoveryState = () => {
    retryNum = 0
    prevTimeoutId = null
    clearDelayNextTimeout()
    clearLoadingTimeout()
  }

  const handleControllerError = async() => {
    // S-5：重入直接返回——两次 error 是同一首歌同一错误（本函数不取事件参数，
    // 只读全局状态），第一次处理已覆盖重试/终态；若第二次是不同歌的错误，须在
    // 第一次的 getPosition 窗口（约 20ms）内完成切歌 + 新歌加载失败才丢处理，
    // 实际不可达（新歌报错须走完 setResource 与引擎加载，远超该窗口）
    if (handlingError) return
    handlingError = true
    try {
      if (!playerState.musicInfo.id) return
      clearLoadingTimeout()
      if (global.lx.isPlayedStop) return
      // 2-4A：停播前先取位置——setStop 与随后 setMusicUrl(isRefresh) 里的 getPosition()
      // 存在竞态，停稳后位置恒为 0；先 await setStop 再取必归零（报告建议方向反了），
      // 故在停播前把当前位置取好、随刷新传给 setMusicUrl。
      const errorMusicId = playerState.playMusicInfo.musicInfo?.id
      const resumePosition = await getPosition().catch(() => playerState.progress.nowPlayTime)
      // await 期间用户可能已切歌/停止/触发定时退出：只对同一首歌继续重试
      if (!playerState.musicInfo.id || global.lx.isPlayedStop || playerState.playMusicInfo.musicInfo?.id !== errorMusicId) return
      if (!isEmpty()) void setStop()
      // 失败歌曲名先在函数作用域取好：终态 toast 在下方 if 块外使用，
      // 若直接用块内声明的 currentMusicInfo 会 ReferenceError（曾与 descExpanded 同型）
      const failedName = playerState.playMusicInfo.musicInfo?.name ?? ''

      // 【对齐上游 usePlayEvent.handleError】失败策略：① 音质逐级降级重试 →
      // ② 同 URL 刷新 ×2 → ③ 失败终态（错误状态 + 延迟自动跳下一首）
      if (playerState.playMusicInfo.musicInfo) {
        const currentMusicInfo = playerState.playMusicInfo.musicInfo
        // ① 高音质 URL 可能返回无法解码的加密内容，换音质重试（在线、非本地/非汽水/非离线）
        // 失败策略（2026-11-12）：按用户设定的音质方向走一档（往下降 = 旧行为；
        // 往上升 = 试更高档，低档加密内容换高档也可能解码成功）
        if (
          'source' in currentMusicInfo &&
          currentMusicInfo.source != 'local' &&
          currentMusicInfo.source != 'qs' &&
          settingState.setting['player.offlineMode'] !== true
        ) {
          const onlineInfo = currentMusicInfo
          const urlSourceInfo = (onlineInfo.meta.toggleMusicInfo ?? onlineInfo)
          const lastQuality = getLastTryQuality(urlSourceInfo.id) ?? getLastTryQuality(currentMusicInfo.id)
          if (lastQuality) {
            const nextQuality = getNextStrategyQuality(lastQuality, getFailureStrategyConfig().qualityDirection, urlSourceInfo, QUALITY_RANK)
            if (nextQuality && nextQuality !== lastQuality) {
              void removeMusicUrl(urlSourceInfo, lastQuality).catch(() => {})
              if (urlSourceInfo !== currentMusicInfo) void removeMusicUrl(currentMusicInfo as LX.Music.MusicInfo, lastQuality).catch(() => {})
              setMusicUrl(currentMusicInfo, true, nextQuality, resumePosition)
              setStatusText(global.i18n.t('player__refresh_url'))
              return
            }
          }
        }
        // ② 若音频 URL 无效则尝试刷新 2 次 URL
        if (retryNum < 2) {
          retryNum++
          setMusicUrl(currentMusicInfo, true, undefined, resumePosition)
          setStatusText(global.i18n.t('player__refresh_url'))
          return
        }
      }

      // ③ 全部失败：标记错误状态，延迟自动跳下一首（本端无 autoSkipOnError 设置项，
      // 保持上游默认开启的自动跳过语义；后台立即跳由 playNext 直达）
      setStatusText(global.i18n.t('player__error'))
      // 【对齐上游 usePlayEvent.handleError 终态】autoSkipOnError 关闭时停留错误状态，
      // 不自动跳下一首
      if (settingState.setting['player.autoSkipOnError']) {
        toast(failedName ? `《${failedName}》播放失败，已自动跳过` : '播放失败，已自动跳过', 'short')
        setTimeout(addDelayNextTimeout)
      } else {
        // 2-4B：终态同理——关闭自动跳过时清 playerTrackId（引擎已在函数开头停掉），
        // 否则播放键见 trackId 非空只调 setPlay()，对失败轨道无重试效果；
        // setStop 在 iOS TrackPlayer 路径下不清 playerTrackId，需手动清
        global.lx.playerTrackId = ''
      }
    } finally {
      // S-5：全部返回路径（含抛错路径）都经 finally 清标志，标志永不置位泄漏
      handlingError = false
    }
  }
  onUnifiedPlayerEvent(async(event) => {
    if (
      event.driver == 'trackPlayer' &&
      (
        global.lx.gettingUrlId ||
        // 2-3：占位音轨过滤改用 isTempId——原 `isEmpty(x) && /restorePlay$/` 两条件互斥、
        // 恒为 false（'//default//restorePlay' 不以 //default 结尾，空串则正则不匹配）
        isTempId(global.lx.playerTrackId)
      )
    ) return
    switch (event.type) {
      case 'state':
        switch (event.state) {
          case 'loading':
            if (!global.lx.isPlayedStop && playerState.musicInfo.id) startLoadingTimeout()
            global.app_event.playerLoadstart()
            setStatusText(global.i18n.t('player__loading'))
            break
          case 'buffering':
            if (!global.lx.isPlayedStop && playerState.musicInfo.id) startLoadingTimeout()
            global.app_event.pause()
            global.app_event.playerWaiting()
            setStatusText(global.i18n.t('player__buffering'))
            break
          case 'playing':
            clearLoadingTimeout()
            // 低-12：真正播起来了就清零失败重试计数——此前只在切歌时清，
            // 同曲中途恢复后再次出错会直接跳过 URL 刷新额度进终态
            retryNum = 0
            setStatusText('')
            if (event.driver == 'nativeFlac') {
              global.lx.playerTrackId = getNativeFlacTrackId()
              // 每次 playing 都恢复音量；高码率音质的“seek 冻结静音”由进度模块的 catchUp
              // 轮询持续维持，不再依赖全局静音标志，避免标志泄漏到其它音质导致“没声音”。
              void setNativeFlacVolume(settingState.setting['player.volume'])
              void setNativeFlacRate(settingState.setting['player.playbackRate'])
              void getPositionStamped().then(async(stamped) => playNowPlaying({ elapsedTime: stamped.position, ...elapsedSnapshotFields(stamped), playbackRate: settingState.setting['player.playbackRate'] }).catch(() => {}))
            } else if (Platform.OS == 'ios') {
              void TrackPlayer.setVolume(settingState.setting['player.volume'])
            }
            if (Platform.OS == 'ios' && playerState.musicInfo.id) {
              // Refresh duration/elapsed metadata after playback actually starts so the
              // iOS lockscreen can render an active progress bar.
              void updateMetaData(playerState.musicInfo, true, playerState.lastLyric, true)
            }
            global.app_event.playerPlaying()
            global.app_event.play()
            startPreload()
            break
          case 'paused':
          case 'stopped':
          case 'idle':
            clearLoadingTimeout()
            if (event.driver == 'nativeFlac' && event.state != 'paused') global.lx.playerTrackId = ''
            global.app_event.playerPause()
            if (event.driver == 'nativeFlac') void getPositionStamped().then(async(stamped) => pauseNowPlaying({ elapsedTime: stamped.position, ...elapsedSnapshotFields(stamped) }).catch(() => {}))
            global.app_event.pause()
            // 2-2：定时退出检查只在终态（stopped/idle）执行——此前放在 case 'state' 末尾，
            // 任意 loading/buffering/playing/paused 事件都会立即退出 App；paused 不是终态，不退
            if (event.state != 'paused' && global.lx.isPlayedStop) void handleExitApp('Timeout Exit')
            break
        }
        break
      case 'error':
        stopPreload()
        global.app_event.error()
        global.app_event.playerError()
        handleControllerError()
        break
      case 'trackChanged':
        global.lx.playerTrackId = event.trackId
        if (event.info?.track == null) return
        if (global.lx.isPlayedStop) return handleExitApp('Timeout Exit')
        if (Platform.OS == 'ios' && event.driver == 'trackPlayer') {
          void TrackPlayer.setVolume(settingState.setting['player.volume'])
        }
        if (Platform.OS != 'ios' && event.driver == 'trackPlayer' && isEmpty()) {
          stopPreload()
          await TrackPlayer.pause()
          global.app_event.playerPause()
          global.app_event.pause()
          global.app_event.playerEnded()
          global.app_event.playerEmptied()
          clearDelayNextTimeout()
          clearLoadingTimeout()
        }
        break
      case 'ended':
        stopPreload()
        global.lx.playerTrackId = ''
        global.app_event.playerPause()
        global.app_event.pause()
        global.app_event.playerEnded()
        global.app_event.playerEmptied()
        clearDelayNextTimeout()
        clearLoadingTimeout()
        // 2-2：播完当前曲目退出的主路径——此前 ended 分支无此检查，全靠 case 'state'
        // 末尾的宽泛检查（任意状态事件都退）；handleEnded 在 isPlayedStop 时拦截 playNext，
        // 故此处是退出时机确定的唯一位置
        if (global.lx.isPlayedStop) void handleExitApp('Timeout Exit')
        break
    }
  })

  global.app_event.on('musicToggled', () => {
    resetRecoveryState()
    startPreload()
  })
  isInitialized = true
}
