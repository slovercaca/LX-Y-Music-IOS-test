import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { search } from '@/core/search/music'
import searchMusicState, { type Source } from '@/store/search/music/state'

// export type MusicListProps = Pick<OnlineListProps,
// 'onLoadMore'
// | 'onPlayList'
// | 'onRefresh'
// >

export interface MusicListType {
  loadList: (text: string, source: Source) => void
}

export default forwardRef<MusicListType, { header?: OnlineListProps['ListHeaderComponent'] }>(({ header }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const searchInfoRef = useRef<{ text: string, source: Source }>({ text: '', source: 'kw' })
  const isUnmountedRef = useRef(false)
  // 2026-10-05 fix（P1-1）：请求序号，丢弃过期搜索结果
  const requestIdRef = useRef(0)
  useImperativeHandle(
    ref,
    () => ({
      async loadList(text, source) {
        // const listDetailInfo = searchMusicState.listDetailInfo
        listRef.current?.setList([], false, source == 'all')
        if (
          searchMusicState.searchText == text &&
          searchMusicState.source == source &&
          searchMusicState.listInfos[searchMusicState.source]!.list.length
        ) {
          // 中：缓存分支也要同步 searchInfoRef 并作废在途请求——此前切回
          // 命中缓存后 refresh 仍按旧词/旧源搜，会把缓存结果清掉
          searchInfoRef.current.text = text
          searchInfoRef.current.source = source
          requestIdRef.current++
          requestAnimationFrame(() => {
            listRef.current?.setList(
              searchMusicState.listInfos[searchMusicState.source]!.list,
              false,
              source == 'all',
            )
          })
        } else {
          listRef.current?.setStatus('loading')
          const page = 1
          searchInfoRef.current.text = text
          searchInfoRef.current.source = source
          const requestId = ++requestIdRef.current
          return search(text, page, source)
            .then((list) => {
              // const result = setListInfo(listDetail, id, page)
              if (isUnmountedRef.current) return
              // 过期请求直接丢弃，避免旧结果清空新结果
              if (requestId !== requestIdRef.current) return
              requestAnimationFrame(() => {
                listRef.current?.setList(list, false, source == 'all')
                listRef.current?.setStatus(
                  searchMusicState.listInfos[searchMusicState.source]!.maxPage <= page
                    ? 'end'
                    : 'idle',
                )
              })
            })
            .catch(() => {
              if (requestId !== requestIdRef.current) return
              listRef.current?.setStatus('error')
            })
        }
      },
    }),
    [],
  )

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    const page = 1
    // 高-4：捕获代际与源——此前 refresh/loadMore 无守卫且回调里读新源，
    // 旧搜索结果会覆盖新搜索、按新源算状态
    const requestId = requestIdRef.current
    const source = searchInfoRef.current.source
    listRef.current?.setStatus('refreshing')
    search(searchInfoRef.current.text, page, source)
      .then((list) => {
        if (isUnmountedRef.current) return
        if (requestId !== requestIdRef.current) return
        listRef.current?.setList(list, false, source == 'all')
        listRef.current?.setStatus(
          searchMusicState.listInfos[source]!.maxPage <= page ? 'end' : 'idle',
        )
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        listRef.current?.setStatus('error')
      })
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    // 高-4：同 handleRefresh，捕获代际/源/分页基准，回调先验
    const requestId = requestIdRef.current
    const source = searchInfoRef.current.source
    listRef.current?.setStatus('loading')
    const info = searchMusicState.listInfos[source]!
    const page = info?.list.length ? info.page + 1 : 1
    search(searchInfoRef.current.text, page, source)
      .then((list) => {
        if (isUnmountedRef.current) return
        if (requestId !== requestIdRef.current) return
        listRef.current?.setList(list, true, source == 'all')
        listRef.current?.setStatus(info.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return
        listRef.current?.setStatus('error')
      })
  }

  return (
    <OnlineList
      ref={listRef}
      listId="search"
      ListHeaderComponent={header}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      checkHomePagerIdle
    />
  )
})
