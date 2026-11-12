import music from '@/utils/musicSdk'

// import { deduplicationList } from '@common/utils/renderer'

import { type ListInfo } from '@/store/songlist/state'
export type { ListInfoItem } from '@/store/songlist/state'

export type SearchListInfo = Omit<ListInfo, 'source' | 'maxPage'>

interface ListInfos extends Partial<Record<LX.OnlineSource, SearchListInfo>> {
  all: SearchListInfo
}

export type Source = LX.OnlineSource | 'all'

export interface InitState {
  searchText: string
  source: Source
  sources: Source[]
  listInfos: ListInfos
  maxPages: Partial<Record<Source, number>>
}

const state: InitState = {
  searchText: '',
  source: 'kw',
  sources: [],
  listInfos: {
    all: {
      page: 1,
      limit: 15,
      total: 0,
      list: [],
      key: null,
      tagId: '',
      sortId: '',
    },
  },
  maxPages: {},
}

// 1-18(e)：模块级死导出 maxPages 已删除（全仓无导入方；state 内的 maxPages 字段是活的，保留）
for (const source of music.sources) {
  if (!music[source.id as LX.OnlineSource]?.songList?.search) continue
  state.sources.push(source.id as LX.OnlineSource)
  state.listInfos[source.id as LX.OnlineSource] = {
    page: 1,
    limit: 18,
    total: 0,
    list: [],
    key: null,
    tagId: '',
    sortId: '',
  }
}
state.sources.push('all')

export default state
