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
    listRef.current?.setStatus('refreshing')
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchMusicState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, false, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(
          searchMusicState.listInfos[searchInfoRef.current.source]!.maxPage <= page ? 'end' : 'idle',
        )
      })
      .catch(() => {
        listRef.current?.setStatus('error')
      })
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    listRef.current?.setStatus('loading')
    const info = searchMusicState.listInfos[searchInfoRef.current.source]!
    const page = info?.list.length ? info.page + 1 : 1
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchMusicState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, true, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(info.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
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
