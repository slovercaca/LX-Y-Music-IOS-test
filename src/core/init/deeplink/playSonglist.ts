import { LIST_IDS } from '@/config/constant'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import listState from '@/store/list/state'

const getListPlayIndex = (list: LX.Music.MusicInfoOnline[], index?: number) => {
  if (index == null) {
    index = 1
  } else {
    if (index < 1) index = 1
    else if (index > list.length) index = list.length
  }
  return index - 1
}

const playSongListDetail = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  // console.log(source, link, playIndex)
  if (link == null) return
  let isPlayingList = false
  // 低：link 已在 deeplink 入口统一解码过一次，此前再解一次——含 %XX
  // 被篡改拉错歌单、裸 % 抛 URIError 被包装成笼统报错
  const id = link
  const playListId = `${source}__${link}`
  let list = (await getListDetail(id, source, 1)).list
  if (playIndex == null || list.length > playIndex) {
    isPlayingList = true
    await setTempList(playListId, list)
    await playList(LIST_IDS.TEMP, getListPlayIndex(list, playIndex))
  }
  list = await getListDetailAll(source, id)
  if (isPlayingList) {
    // 中：此前拿裸 id 与 tempListMeta.id（kw__123 形式）比较恒 false，
    // 全量列表永远换不进临时列表、只剩第一页 ≤30 首
    if (listState.tempListMeta.id == playListId) await setTempList(playListId, list)
  } else {
    await setTempList(playListId, list)
    await playList(LIST_IDS.TEMP, getListPlayIndex(list, playIndex))
  }
}
export const playSonglist = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  try {
    await playSongListDetail(source, link, playIndex)
  } catch (err) {
    console.error(err)
    throw new Error('Get play list failed.')
  }
}
