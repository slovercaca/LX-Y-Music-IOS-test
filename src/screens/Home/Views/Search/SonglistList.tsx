import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactElement } from 'react'

import { search } from '@/core/search/songlist'
import Songlist, {
  type SonglistProps,
  type SonglistType,
} from '@/screens/Home/Views/SongList/components/Songlist'
import searchSonglistState, { type ListInfoItem, type Source } from '@/store/search/songlist/state'

// export type MusicListProps = Pick<OnlineListProps,
// 'onLoadMore'
// | 'onPlayList'
// | 'onRefresh'
// >

export interface MusicListType {
  loadList: (text: string, source: Source) => void
}
interface SonglistListProps {
  header?: ReactElement
  onOpenDetail: (item: ListInfoItem, index: number) => void
}
export default forwardRef<MusicListType, SonglistListProps>(({ header, onOpenDetail }, ref) => {
  const listRef = useRef<SonglistType>(null)
  const searchInfoRef = useRef<{ text: string, source: Source }>({ text: '', source: 'kw' })
  const isUnmountedRef = useRef(false)
  // 2026-10-05 fix（P1-1）：请求序号，丢弃过期搜索结果
  const requestIdRef = useRef(0)
  useImperativeHandle(
    ref,
    () => ({
      async loadList(text, source) {
        // const listDetailInfo = searchSonglistState.listDetailInfo
        listRef.current?.setList([], source == 'all')
        if (
          searchSonglistState.searchText == text &&
          searchSonglistState.source == source &&
          searchSonglistState.listInfos[searchSonglistState.source]!.list.length
        ) {
          requestAnimationFrame(() => {
            listRef.current?.setList(
              searchSonglistState.listInfos[searchSonglistState.source]!.list,
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
              // 过期请求直接丢弃
              if (requestId !== requestIdRef.current) return
              requestAnimationFrame(() => {
                listRef.current?.setList(list, source == 'all')
                listRef.current?.setStatus(
                  searchSonglistState.maxPages[searchSonglistState.source] == page ? 'end' : 'idle',
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

  const handleRefresh: SonglistProps['onRefresh'] = () => {
    const page = 1
    listRef.current?.setStatus('refreshing')
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchSonglistState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(
          searchSonglistState.maxPages[searchSonglistState.source] == page ? 'end' : 'idle',
        )
      })
      .catch(() => {
        listRef.current?.setStatus('error')
      })
  }
  const handleLoadMore: SonglistProps['onLoadMore'] = () => {
    listRef.current?.setStatus('loading')
    const info = searchSonglistState.listInfos[searchInfoRef.current.source]!
    const page = info.list.length ? info.page + 1 : 1
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchSonglistState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(
          searchSonglistState.maxPages[searchSonglistState.source] == page ? 'end' : 'idle',
        )
      })
      .catch(() => {
        listRef.current?.setStatus('error')
      })
  }

  return <Songlist ref={listRef} header={header} onRefresh={handleRefresh} onLoadMore={handleLoadMore} onOpenDetail={onOpenDetail} />
})
