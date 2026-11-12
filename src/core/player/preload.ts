import { getMusicUrl, getLyricInfo } from '@/core/music'
import { getNextPlayMusicInfo } from '@/core/player/player'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { preloadLog } from '@/utils/preloadLog'

let isPreloading = false
// 中-5：预加载代际——stopPreload 只翻布尔时，在途循环还活着，停了又启会叠出
// 两条并发预加载循环重复取链。代际递增让旧循环在下一轮自退。
let preloadGen = 0
// 2-6：当前持有 isPreloading 的循环代际。stopPreload 只递增 preloadGen、不立即清
// 标志（否则旧循环还在 await 时新循环即可启动、并发取链）；finally 按「持有代际」
// 而非 preloadGen 判断是否清标志——被新一代接管时不碰，被 stop 作废且无人接管时
// 由旧循环清掉，避免标志永久置位、预加载再也启动不了。
let preloadingGen = -1

const preloadNextMusic = async() => {
  // 2-6：运行中的循环若已被 stopPreload 作废（持有代际落后于当前代际），允许新循环
  // 接管；同代循环运行中才拒绝重入
  if (isPreloading && preloadingGen === preloadGen) return
  if (!settingState.setting['player.isEnableAudioPreload']) return

  const currentMusicInfo = playerState.playMusicInfo.musicInfo
  if (!currentMusicInfo) {
    preloadLog.info('No current music info, skipping preload')
    return
  }

  isPreloading = true
  const gen = preloadGen
  preloadingGen = gen
  preloadLog.info('========== Preload Start ==========')

  try {
    const nextPlayMusicInfo = await getNextPlayMusicInfo()
    if (!nextPlayMusicInfo) {
      preloadLog.info('No next song to preload')
      return
    }

    const musicInfo = nextPlayMusicInfo.musicInfo
    if ('progress' in musicInfo) {
      preloadLog.info('Skipping download item, not preloading')
      return
    }

    preloadLog.info(`Target: "${musicInfo.name}" - "${musicInfo.singer}" (source: ${musicInfo.source}, id: ${musicInfo.id})`)

    let success = false
    let currentInfo = musicInfo
    let tryCount = 0
    const maxTries = 5
    // 2026-10-05：记录已尝试过的歌曲 id——getNextPlayMusicInfo 在切歌前
    // 返回的仍是同一首“下一首”，不加去重会把同一首歌连试 5 次（日志风暴）。
    const attemptedIds = new Set<string>([musicInfo.id])
    // 确定性 404（WebDAV 远端文件不存在）：重试同一 URL 永远不会成功，直接停。
    const isDeterministicNotFound = (err: any) => /404|找不到该文件/.test(String(err?.message ?? err))

    while (!success && tryCount < maxTries) {
      if (gen !== preloadGen) {
        preloadLog.info('Preload superseded by stop/restart, exit loop')
        return
      }
      try {
        preloadLog.info(`Attempt ${tryCount + 1}/${maxTries} for "${currentInfo.name}" from "${currentInfo.source}"`)

        const url = await getMusicUrl({
          musicInfo: currentInfo,
          isRefresh: false,
          allowToggleSource: true,
          onToggleSource: (mInfo) => {
            if (mInfo) {
              preloadLog.info(`Source toggled to "${mInfo.source}" for "${mInfo.name}"`)
              currentInfo = mInfo
            }
          },
        })

        // 2-6：await 返回后立即校验代际——已被 stop/新循环作废时直接退出，不再置
        // success、不再为已作废的下一首预取歌词（此前只在循环顶部与 finally 校验）
        if (gen !== preloadGen) {
          preloadLog.info('Preload superseded after getMusicUrl, exit')
          return
        }
        success = true
        preloadLog.info(`Success! URL cached for "${currentInfo.name}" (length: ${url?.length || 0})`)
        // 预取歌词：缓存歌词，切歌后歌词立即就绪，与音频真实位置实时同步，
        // 避免切歌瞬间歌词异步加载造成的「歌词滞后于音频」。
        void getLyricInfo({ musicInfo: currentInfo, isRefresh: false }).catch(() => {})
      } catch (err: any) {
        preloadLog.error(`Failed attempt ${tryCount + 1} for "${currentInfo.name}": ${err?.message || err}`)

        if (isDeterministicNotFound(err)) {
          preloadLog.warn(`Deterministic 404 for "${currentInfo.name}", stop retrying`)
          break
        }

        if (tryCount < maxTries - 1) {
          const nextInfo = await getNextPlayMusicInfo()
          if (nextInfo && !('progress' in nextInfo.musicInfo) && !attemptedIds.has(nextInfo.musicInfo.id)) {
            preloadLog.info(`Fallback to next song: "${nextInfo.musicInfo.name}"`)
            currentInfo = nextInfo.musicInfo
            attemptedIds.add(currentInfo.id)
          } else {
            preloadLog.info('No more songs available for fallback')
            break
          }
        }
      }

      tryCount++
    }

    if (!success) {
      preloadLog.warn(`All ${tryCount} attempts failed, no URL cached`)
    }
  } catch (err: any) {
    preloadLog.error(`Unexpected error: ${err?.message || err}`)
  } finally {
    // 2-6：只有当前持有标志的代际才清标志——被新一代接管时不碰新循环的状态；
    // 被 stop 作废且无人接管时由旧循环清掉（原 `gen === preloadGen` 判断在
    // stopPreload 不再清标志后会让标志永久置位，见文件头注释）
    if (gen === preloadingGen) isPreloading = false
    preloadLog.info('========== Preload End ==========')
  }
}

export const startPreload = () => {
  if (!settingState.setting['player.isEnableAudioPreload']) return
  preloadLog.init()
  void preloadNextMusic()
}

export const stopPreload = () => {
  // 2-6：只递增代际、不立即清 isPreloading——旧循环可能正 await getMusicUrl()，
  // 立即清标志会让新循环马上启动、两条循环并发取链；旧循环在 await 返回后
  // （或循环顶部）校验代际自退，finally 按持有代际清标志
  preloadGen++
}
