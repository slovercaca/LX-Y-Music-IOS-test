import { arrPush, arrUnshift, formatPlayTime2 } from '@/utils'
import { clamp01 } from '@/utils/tools'
import state from './state'

type PlayerMusicInfoKeys = keyof LX.Player.MusicInfo
const musicInfoKeys: PlayerMusicInfoKeys[] = Object.keys(state.musicInfo) as PlayerMusicInfoKeys[]

export default {
  updatePlayIndex(playIndex: number, playerPlayIndex: number) {
    state.playInfo.playIndex = playIndex
    state.playInfo.playerPlayIndex = playerPlayIndex

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayListId(playerListId: string | null) {
    state.playInfo.playerListId = playerListId

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayMusicInfo(
    listId: string | null,
    musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null,
    isTempPlay: boolean = false,
  ) {
    state.playMusicInfo = { listId, musicInfo, isTempPlay }

    // 切歌时清掉上一首的实际流信息（音质/实际源），避免详情页在新歌取链完成前
    // 显示上一首的实际值；setResource 会在取链成功后重新写入并广播。
    // 同歌刷新不走这里（setMusicUrl isRefresh 不调 setPlayMusicInfo），不闪烁。
    state.quality = null
    state.actualSource = null
    global.state_event.playStreamInfoChanged({ quality: null, actualSource: null })

    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  },
  setMusicInfo(_musicInfo: Partial<LX.Player.MusicInfo>) {
    for (const key of musicInfoKeys) {
      const val = _musicInfo[key]
      if (val !== undefined) {
        // @ts-expect-error
        state.musicInfo[key] = val
      }
    }

    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  },
  setIsPlay(isPlay: boolean) {
    state.isPlay = isPlay

    global.state_event.playStateChanged(isPlay)
  },
  setStatusText(statusText: string) {
    state.statusText = statusText
    global.state_event.playStateTextChanged(statusText)
  },
  setNowPlayTime(time: number) {
    // 1-18(b)：非有限值不写入——NaN 会存进 nowPlayTime 并显示为 NaN:NaN
    if (!Number.isFinite(time)) return
    state.progress.nowPlayTime = time
    state.progress.nowPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = state.progress.maxPlayTime ? clamp01(time / state.progress.maxPlayTime) : 0 // 低：引擎上报 position>duration 时进度溢出，与 setProgress 同口径钳制

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setMaxplayTime(time: number) {
    // 1-18(b)：非有限值不写入——NaN 会存进 maxPlayTime 并显示为 NaN:NaN
    if (!Number.isFinite(time)) return
    state.progress.maxPlayTime = time
    state.progress.maxPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = time ? clamp01(state.progress.nowPlayTime / time) : 0 // 低：同上

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setProgress(currentTime: number, totalTime: number) {
    // 1-18(b)：与 setNowPlayTime/setMaxplayTime 同口径——任一非有限值整条跳过，
    // 否则 NaN 会存进 nowPlayTime/maxPlayTime 并显示为 NaN:NaN
    if (!Number.isFinite(currentTime) || !Number.isFinite(totalTime)) return
    state.progress.nowPlayTime = currentTime
    state.progress.nowPlayTimeStr = formatPlayTime2(currentTime)
    state.progress.maxPlayTime = totalTime
    state.progress.maxPlayTimeStr = formatPlayTime2(totalTime)
    // 进度比例必须是「已播放 / 总时长」。原写法为 nowPlayTime / currentTime（两者相等），
    // 结果恒为 1（currentTime 为 0 时更是 NaN），切歌瞬间进度条会直接满格 / 崩成 NaN。
    state.progress.progress = totalTime > 0 ? clamp01(currentTime / totalTime) : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  addPlayedList(info: LX.Player.PlayMusicInfo) {
    if (state.playedList.some((m) => m.musicInfo.id == info.musicInfo.id)) return
    state.playedList.push(info)

    global.state_event.playPlayedListChanged([...state.playedList])
  },
  removePlayedList(index: number) {
    state.playedList.splice(index, 1)

    global.state_event.playPlayedListChanged([...state.playedList])
  },
  clearPlayedList() {
    state.playedList = []

    global.state_event.playPlayedListChanged([...state.playedList])
  },
  addTempPlayList(list: LX.Player.TempPlayListItem[]) {
    const topList: Array<{
      listId: string | null
      musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
    }> = []
    const bottomList = list.filter(({ isTop, ...musicInfo }) => {
      if (isTop) {
        topList.push(musicInfo)
        return false
      }
      return true
    })
    if (topList.length) {
      arrUnshift(
        state.tempPlayList,
        topList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })) as any,
      )
    }
    if (bottomList.length) {
      arrPush(
        state.tempPlayList,
        bottomList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })) as any,
      )
    }

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  removeTempPlayList(index: number) {
    state.tempPlayList.splice(index, 1)

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  clearTempPlayeList() {
    state.tempPlayList = []

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  setLoadErrorPicUrl(url: string) {
    state.loadErrorPicUrl = url
  },
  setLastLyric(lrc?: string) {
    state.lastLyric = lrc
  },
}
