export interface InitState {
  playMusicInfo: {
    /**
     * 当前播放歌曲的列表 id
     */
    musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | null
    /**
     * 当前播放歌曲的列表 id
     */
    listId: LX.Player.PlayMusicInfo['listId'] | null
    /**
     * 是否属于 “稍后播放”
     */
    isTempPlay: boolean
  }
  playInfo: LX.Player.PlayInfo
  musicInfo: LX.Player.MusicInfo

  isPlay: boolean
  volume: number
  playRate: number
  statusText: string

  /**
   * 当前实际播放的音质（如 'flac' | 'flac24bit' | 'master' | 'atmos' 等）。
   * 由 setResource 在取链成功后写入，切歌时由 setPlayMusicInfo 清零；
   * 详情页徽章用它对比请求音质（O-6：旧注释称的 seek 冻结消费者不存在，
   * 全仓除徽章外无其他读点，原生 FLAC 判定用 setResource 传入的参数）。
   */
  quality: LX.Quality | null

  /**
   * 当前实际取链的平台（失败策略换源成功时为目标平台，否则为歌曲自身平台）。
   * 与 quality 一起由 setResource 写入、切歌时由 setPlayMusicInfo 清零，
   * 供详情页展示「原平台/音质 → 实际平台/音质」。
   */
  actualSource: LX.Source | null

  playedList: LX.Player.PlayMusicInfo[]
  tempPlayList: LX.Player.PlayMusicInfo[]

  loadErrorPicUrl: string

  progress: {
    nowPlayTime: number
    maxPlayTime: number
    progress: number
    nowPlayTimeStr: string
    maxPlayTimeStr: string
  }

  lastLyric: string | undefined
}

const state: InitState = {
  playInfo: {
    playIndex: -1,
    playerListId: null,
    playerPlayIndex: -1,
  },
  playMusicInfo: {
    listId: null,
    musicInfo: null,
    isTempPlay: false,
  },
  musicInfo: {
    id: null,
    pic: null,
    lrc: null,
    tlrc: null,
    rlrc: null,
    lxlrc: null,
    rawlrc: null,
    // url: null,
    name: '',
    alias: '',
    singer: '',
    album: '',
  },

  isPlay: false,
  volume: 1,
  playRate: 1,
  statusText: '',
  quality: null,
  actualSource: null,
  loadErrorPicUrl: '',

  playedList: [],
  tempPlayList: [],

  progress: {
    nowPlayTime: 0,
    maxPlayTime: 0,
    progress: 0,
    nowPlayTimeStr: '00:00',
    maxPlayTimeStr: '00:00',
  },

  lastLyric: undefined,
}

export default state
