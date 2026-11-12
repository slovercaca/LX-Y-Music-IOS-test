import searchSonglistState, { type Source, type ListInfoItem } from '@/store/search/songlist/state'
import searchSonglistActions, { type SearchResult } from '@/store/search/songlist/action'
import musicSdk from '@/utils/musicSdk'
import { toast } from '@/utils/tools'

export const setSource: (typeof searchSonglistActions)['setSource'] = (source) => {
  searchSonglistActions.setSource(source)
}
export const setSearchText: (typeof searchSonglistActions)['setSearchText'] = (text) => {
  searchSonglistActions.setSearchText(text)
}
const setListInfo: typeof searchSonglistActions.setListInfo = (result, page, text) => {
  return searchSonglistActions.setListInfo(result, page, text)
}

export const clearListInfo: typeof searchSonglistActions.clearListInfo = (source) => {
  searchSonglistActions.clearListInfo(source)
}

export const search = async(
  text: string,
  page: number,
  sourceId: Source,
): Promise<ListInfoItem[]> => {
  if (sourceId === 'bilibili') {
    toast('哔哩哔哩音源暂不支持歌单搜索')
    return []
  }

  const listInfo = searchSonglistState.listInfos[sourceId]!
  // if (!text) return []
  const key = `${page}__${sourceId}__${text}`
  if (listInfo.key == key && listInfo.list.length) return listInfo.list
  if (sourceId == 'all') {
    listInfo.key = key
    let task = []
    for (const source of searchSonglistState.sources) {
      if (source == 'all' || (page > 1 && page > searchSonglistState.maxPages[source]!)) continue
      task.push(
        (
          (musicSdk[source]?.songList.search(
            text,
            page,
            searchSonglistState.listInfos.all.limit,
          ) as Promise<SearchResult>) ?? Promise.reject(new Error('source not found: ' + source))
        ).catch((error: any) => {
          console.log(error)
          return {
            list: [],
            total: 0,
            limit: searchSonglistState.listInfos.all.limit,
            source,
          }
        }),
      )
    }
    return Promise.all(task).then((results: SearchResult[]) => {
      if (key != listInfo.key) return []
      setSearchText(text)
      setSource(sourceId)
      return setListInfo(results, page, text)
    })
  } else {
    if (listInfo?.key == key && listInfo?.list.length) return listInfo?.list
    listInfo.key = key
    const songList = musicSdk[sourceId]?.songList
    if (!songList?.search) return Promise.reject(new Error('source not found: ' + sourceId))
    return (
      songList.search(text, page, listInfo.limit) as Promise<SearchResult>
    ).then((data: SearchResult) => {
      if (key != listInfo.key) return []
      return setListInfo(data, page, text)
    }).catch((err: any) => {
      // 2026-10-05 fix（P1-9）：过期请求的 catch 不清空当前结果
      if (key != listInfo.key) throw err
      if (listInfo.list.length && page == 1) clearListInfo(sourceId)
      // 2-13：同音乐侧，翻页失败回退 key 使加载更多重试能真正发请求
      listInfo.key = page > 1 ? `${page - 1}__${sourceId}__${text}` : null
      throw err
    })
  }
}
