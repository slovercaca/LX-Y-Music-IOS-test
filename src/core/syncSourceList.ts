// import { dateFormat } from '@/utils/common'
import { setListUpdateTime } from '@/utils/data'
import { overwriteListMusics, setFetchingListStatus } from './list'
import { getListDetailAll } from '@/core/songlist'
import { getListDetailAll as getBoardListAll } from '@/core/leaderboard'

const fetchList = async(id: string, source: LX.OnlineSource, sourceListId: string) => {
  setFetchingListStatus(id, true)

  let promise
  if (/^board__/.test(sourceListId)) {
    const id = sourceListId.replace(/^board__/, '')
    promise = id
      ? getBoardListAll(id, true)
      : Promise.reject(new Error('id not defined: ' + sourceListId))
  } else {
    promise = getListDetailAll(source, sourceListId, true)
  }
  return promise.finally(() => {
    setFetchingListStatus(id, false)
  })
}

export default async(targetListInfo: LX.List.UserListInfo) => {
  // console.log(targetListInfo)
  if (!targetListInfo.source || !targetListInfo.sourceListId) return
  const list = await fetchList(
    targetListInfo.id,
    targetListInfo.source,
    targetListInfo.sourceListId,
  )
  // 存疑处理：此前 overwriteListMusics 未等待就推进更新时间戳——覆盖
  // 失败时列表显示已同步但内容是旧的、且 rejection 无人处理。改为先
  // 等落盘成功再记时间，失败记日志不推进时间戳。
  try {
    await overwriteListMusics(targetListInfo.id, list)
    await setListUpdateTime(targetListInfo.id, Date.now())
  } catch (err: any) {
    console.warn('[SyncSourceList] 歌单落盘失败:', err?.message ?? err)
  }
  // TODO
  // setUpdateTime(targetListInfo.id, dateFormat(now))
}
