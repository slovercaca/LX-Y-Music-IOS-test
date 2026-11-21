import songList from './songList'
import leaderboard from './leaderboard'

// 汽水音乐：实现歌单打开 + 排行榜（均无需登录/签名）。
// 歌曲播放/歌词/封面走「其他源匹配」链路（见 core/music/index.ts 对 'qs' 的分发）。
const qishui = {
  songList,
  leaderboard,
  // Bug 42：补齐接口契约要求的 getMusicDetailPageUrl——汽水无稳定的歌曲详情页
  // URL 方案，返回空串最稳妥（两处真实调用点「查看音源详情」与 shareMusic 均已处理空串）。
  getMusicDetailPageUrl() {
    return ''
  },
}

export default qishui
