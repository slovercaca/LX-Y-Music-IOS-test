import { setNavActiveId } from '@/core/common'
import { saveSearchSetting } from '@/utils/data'
import { setSearchText, addHistoryWord } from '@/core/search/search'
import { setPendingAction } from '@/core/pendingAction'
import commonState from '@/store/common/state'

const PLATFORM_MAP: Record<string, string> = {
  kw: 'kw',
  kg: 'kg',
  tx: 'tx',
  wy: 'wy',
  mg: 'mg',
  bilibili: 'bilibili',
}

const TYPE_MAP: Record<string, string> = {
  music: 'music',
  songlist: 'songlist',
  singer: 'singer',
  album: 'album',
}

const handleSearch = async(params: Record<string, any>) => {
  const { keyword, platform, type } = params

  let source = ''
  if (platform) {
    source = PLATFORM_MAP[platform] || platform
    const validSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'bilibili']
    if (!validSources.includes(source)) {
      throw new Error(`Unknown platform: ${platform}`)
    }
    await saveSearchSetting({ source: source as LX.OnlineSource })
  }

  let searchType = ''
  if (type) {
    searchType = TYPE_MAP[type] || type
    const validTypes = ['music', 'songlist', 'singer', 'album']
    if (!validTypes.includes(searchType)) {
      throw new Error(`Unknown search type: ${type}`)
    }
    await saveSearchSetting({ type: searchType as any })
  }

  if (keyword) {
    setSearchText(keyword)
    await addHistoryWord(keyword)
    // 1-21③：不再切导航后立即发事件——冷启动时 Search 页尚未挂载、监听
    // 未注册，事件会丢。已在搜索页时立即发；否则经 pendingAction 由页面
    // 在切入/挂载时消费并转发（见 Search/index.tsx）
    if (commonState.navActiveId === 'nav_search') {
      global.app_event.searchDeepLink(keyword, source, searchType)
    } else {
      setPendingAction({ type: 'searchDeepLink', data: { keyword, source, type: searchType } })
      setNavActiveId('nav_search')
    }
  } else {
    // S-1：必须带 data: true——consumePendingAction 返回的是 data，
    // 不带时消费侧真值检查恒假（见 Search/index.tsx:177/186），
    // 无关键词搜索 deeplink 永不聚焦输入框（与 M-2 同根因）
    // S-X1-1：已在搜索页时同值 setNavActiveId 会短路、不发导航事件，
    // 待办会滞留到下次切入时才聚焦（一次多余聚焦）。已在页内时直接发
    // searchDeepLink('', '', '')——handler 空关键词时只聚焦、不搜；
    // 否则经 pendingAction 由页面在切入/挂载时消费聚焦（与有关键词分支同款）
    if (commonState.navActiveId === 'nav_search') {
      global.app_event.searchDeepLink('', '', '')
    } else {
      setPendingAction({ type: 'searchFocus', data: true })
      setNavActiveId('nav_search')
    }
  }
}

export const handleSearchAction = async(_action: string, params: Record<string, any>) => {
  await handleSearch(params)
}
