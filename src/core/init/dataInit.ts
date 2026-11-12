// import { getPlayInfo } from '@/utils/data'
// import { log } from '@/utils/log'
import { init as musicSdkInit } from '@/utils/musicSdk'
import { getUserLists, setUserList } from '@/core/list'
import { setNavActiveId, forceSyncNavActiveId } from '../common'
import { getViewPrevState, cleanOneDriveDirtyData } from '@/utils/data'
import { bootLog } from '@/utils/bootLog'
import { getDislikeInfo, setDislikeInfo } from '@/core/dislikeList'
import { unlink } from '@/utils/fs'
import { TEMP_FILE_PATH } from '@/utils/tools'
import wyUserApi from '@/utils/musicSdk/wy/user'
import txUserApi from '@/utils/musicSdk/tx/user'
import { getUserPlaylists as getKgUserPlaylists } from '@/utils/musicSdk/kg/utils/api'
import {
  setWyFollowedArtists,
  setWyLikedSongs,
  setWySubscribedAlbums,
  setWyUid,
  setTxLikedSongs,
  setKgLikedSongs,
} from '@/store/user/action.ts'
import { getDownloadTasks } from '@/utils/data/download.ts'
import downloadActions from '@/store/download/action'
import { withTimeout } from '@/utils/withTimeout'
import { DEFAULT_SETTING } from '@/config/constant'
import settingState from '@/store/setting/state'
// S-3：晚到值应用前需判断当前数据集是否仍为空（仍是兜底值），
// 避免覆盖用户在超时后的修改；三个 state 模块均为叶子模块，无循环引用
import listState from '@/store/list/state'
import downloadState from '@/store/download/state'
import { state as dislikeState } from '@/store/dislikeList/state'

// 1-5 后续：启动拉取与 Cookie 监听各有独立代际——启动后数秒内换 Cookie，
// 启动拉取的旧结果仍可能晚到覆盖。写回前比对发起时 Cookie 与当前值，
// 不一致即丢弃（与监听的 reqGen 代际同效，无需跨模块共享计数器）
const isCookieCurrent = (key: 'common.wy_cookie' | 'common.tx_cookie' | 'common.kg_cookie', cookieAtStart: string) =>
  settingState.setting[key] === cookieAtStart

// S-3：超时后原 promise 仍在跑（withTimeout 不取消原 promise）——给它挂
// .then，晚到的真实值仍经 onLate 补进 store，否则该数据集整会话为空且无
// 重试。timedOut 标志保证正常路径（3 秒内返回）不重复应用；拒绝分支吞掉
// （兜底值已在用，失败无须处理），避免未处理 rejection。onLate 回调内部
// 须自带「仍为空」判断，见各调用点。
const withInitTimeout = async <T,>(promise: Promise<T>, label: string, fallback: T, onLate?: (value: T) => void): Promise<T> => {
  let timedOut = false
  if (onLate) {
    promise.then(
      (value) => { if (timedOut) onLate(value) },
      () => {},
    )
  }
  return withTimeout(promise, label, fallback, undefined, () => { timedOut = true })
}

// 1-2：启动数据初始化拆成两段——本地段（歌单/不喜欢/下载任务/上次 Tab）
// 在 pushHomeScreen 之前 await，首帧直接落在恢复的 Tab，且 deeplink 触发时
// setUserList/setTasks 已完成；网络段（Cookie 拉取）保留后台。
export const initLocalData = async() => {
  void musicSdkInit()
  bootLog('User list init...')
  const userLists = await withInitTimeout(getUserLists(), 'User list', [], (lateLists) => {
    // S-3：仅当当前仍为空（仍是兜底值）时才应用晚到值——用户其后若已新建
    // 歌单，晚到值不得覆盖用户修改。setUserList 为纯内存写，无磁盘风险。
    if (listState.userList.length === 0) setUserList(lateLists)
  })
  bootLog('User list data loaded.')
  setUserList(userLists)
  bootLog('User list state set.')
  const dislikeInfo = await withInitTimeout(getDislikeInfo(), 'Dislike info', {
    names: new Set<string>(),
    musicNames: new Set<string>(),
    singerNames: new Set<string>(),
    rules: '',
  }, (lateInfo) => {
    // S-3：仅当当前仍为空（仍是兜底值）时才应用晚到值——用户其后若已添加
    // 不喜欢规则，晚到值不得覆盖用户修改。setDislikeInfo 为纯内存写。
    const current = dislikeState.dislikeInfo
    if (current.names.size === 0 && current.musicNames.size === 0 && current.singerNames.size === 0 && current.rules === '') {
      setDislikeInfo(lateInfo)
    }
  })
  bootLog('Dislike info data loaded.')
  setDislikeInfo(dislikeInfo)
  bootLog('User list inited.')

  void cleanOneDriveDirtyData().then(() => { bootLog('OneDrive dirty data cleaned.') }).catch((err) => { bootLog(`OneDrive dirty data clean failed: ${err?.message ?? err}`) })


  bootLog('Download tasks init...')
  const savedTasks = await withInitTimeout(getDownloadTasks(), 'Download tasks', [], (lateTasks) => {
    // S-3：仅当当前仍为空（仍是兜底值）时才应用晚到值——用户其后若已新增
    // 下载任务，晚到值不得覆盖。setTasks 为纯内存写，无磁盘风险。
    if (downloadState.tasks.length === 0) downloadActions.setTasks(lateTasks)
  })
  bootLog('Download task data loaded.')
  downloadActions.setTasks(savedTasks)
  bootLog('Download tasks inited.')

  // 1-2：上次 Tab 在 push 前读好，首帧 initialPage 直接落在恢复的 Tab；
  // forceSync 仍保留——setNavActiveId 同值短路时 PagerView 仍需一次重播校正
  // S-3：上次 Tab 不挂晚到应用——超时后用户可能已手动切 Tab，晚到的旧 Tab
  // 会把页面强行拽走；兜底值与初始 Tab 相同，无功能损失
  setNavActiveId((await withInitTimeout(getViewPrevState(), 'View prev state', { ...DEFAULT_SETTING.viewPrevState })).id)
  forceSyncNavActiveId()
  void unlink(TEMP_FILE_PATH)
}

// 1-2：Cookie 拉取等网络部分保留后台（不阻塞 pushHomeScreen）
export const initRemoteData = async(appSetting: LX.AppSetting) => {
  const wy_cookie = appSetting['common.wy_cookie']
  if (wy_cookie) {
    bootLog('Wy like list init...')
    wyUserApi.getUid(wy_cookie)
      .then((uid: any) => {
        // 1-5 后续：Cookie 已换则不写回、不再拉取（监听侧会按新 Cookie 重拉）
        if (!isCookieCurrent('common.wy_cookie', wy_cookie)) return
        setWyUid(uid)
        // 低：此前独缺 .catch（相邻两段都有），失败变 unhandled rejection 且 bootLog 无记录
        wyUserApi.getLikedSongList(uid, wy_cookie).then((ids: any) => {
          if (!isCookieCurrent('common.wy_cookie', wy_cookie)) return
          setWyLikedSongs(ids)
          bootLog('Wy like list inited.')
        }).catch((err: any) => {
          bootLog(`Wy like list init failed: ${err?.message ?? err}`)
        })
        wyUserApi.getAllSublist().then(artists => {
          if (!isCookieCurrent('common.wy_cookie', wy_cookie)) return
          setWyFollowedArtists(artists)
          bootLog('Wy followed artists inited.')
        }).catch(err => {
          bootLog(`Wy followed artists init failed: ${err.message}`)
        })
        wyUserApi.getAllSubAlbumList().then(albums => {
          if (!isCookieCurrent('common.wy_cookie', wy_cookie)) return
          setWySubscribedAlbums(albums)
          bootLog('Wy liked albums inited.')
        }).catch(err => {
          bootLog(`Wy liked albums init failed: ${err.message}`)
        })
        // 「我的歌单」按用户规则推迟：**第一次点开该平台歌单时才拉取并缓存**
        // （不在启动时预拉，故这里不再调用 getPlaylistIndex）
      })
      .catch((err: any) => {
        bootLog(`Wy like list init failed: ${err.message}`)
      })
  }

  const tx_cookie = appSetting['common.tx_cookie']
  if (tx_cookie) {
    bootLog('Tx like list init...')
    ;(async() => {
      try {
        const allLikedMids: string[] = []
        let page = 1
        const pageSize = 100
        let hasMore = true

        while (hasMore) {
          const result = await txUserApi.getFavSongs(page, pageSize)
          if (result.list && result.list.length > 0) {
            allLikedMids.push(...result.list.map((song: any) => song.mid))
          }
          hasMore = result.hasMore
          page++
        }

        // 1-5 后续：Cookie 已换则丢弃旧账号结果（监听侧会按新 Cookie 重拉）
        if (!isCookieCurrent('common.tx_cookie', tx_cookie)) return
        setTxLikedSongs(allLikedMids)
        bootLog(`Tx like list inited. (${allLikedMids.length} songs)`)
      } catch (err: any) {
        bootLog(`Tx like list init failed: ${err.message}`)
      }
    })()

    // TX「我的歌单」同样推迟到第一次点开时拉取并缓存（见上）
  }

  const kg_cookie = appSetting['common.kg_cookie']
  if (kg_cookie) {
    bootLog('Kg like list init...')
    // kg 的「红心歌曲」需要「我喜欢的音乐」歌单 id：这里直接查一次（**不写**歌单索引缓存），
    // 歌单列表本身按规则推迟到「第一次点开酷狗歌单」时拉取并缓存。
    getKgUserPlaylists(kg_cookie).then(async(result) => {
      // 1-5 后续：Cookie 已换则不再拉取红心歌单（监听侧会按新 Cookie 重拉）
      if (!isCookieCurrent('common.kg_cookie', kg_cookie)) return
      const createdList = result?.success && result.data ? (result.data.createdList ?? []) : []
      const favoritesPlaylist = createdList.find((p: any) => p.isFavorites)
      if (favoritesPlaylist) {
        bootLog('Kg like list init...')
        try {
          const { getPlaylistSongs } = await import('@/utils/musicSdk/kg/utils/api')
          const allLikedIds: string[] = []
          let page = 1
          const pageSize = 500
          let hasMore = true

          while (hasMore) {
            const songsResult = await getPlaylistSongs(kg_cookie, favoritesPlaylist.id, page, pageSize)
            if (songsResult.success && songsResult.data?.list?.length) {
              for (const song of songsResult.data.list) {
                const songId = song.hash || song.songmid || song.audio_id
                if (songId) {
                  allLikedIds.push(String(songId))
                }
              }
              hasMore = songsResult.data.list.length === pageSize
              page++
            } else {
              hasMore = false
            }
          }

          // 1-5 后续：分页拉取期间 Cookie 已换则丢弃旧账号结果
          if (!isCookieCurrent('common.kg_cookie', kg_cookie)) return
          setKgLikedSongs(allLikedIds)
          bootLog(`Kg like list inited. (${allLikedIds.length} songs)`)
        } catch (err: any) {
          bootLog(`Kg like list init failed: ${err.message}`)
        }
      }
    }).catch(err => {
      bootLog(`Kg playlists init failed: ${err.message}`)
    })
  }

}
