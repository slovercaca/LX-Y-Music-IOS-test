import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type ReactElement } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import {
  clearListDetail,
  getListDetail,
  setListDetail,
  setListDetailInfo,
} from '@/core/leaderboard'
import boardState from '@/store/leaderboard/state'
import { shouldRefreshByTtl, markRefreshed } from '@/core/refreshThrottle'
import { handlePlay } from './listAction'

// export type MusicListProps = Pick<OnlineListProps,
// 'onLoadMore'
// | 'onPlayList'
// | 'onRefresh'
// >

export interface MusicListType {
  loadList: (source: LX.OnlineSource, listId: string) => void
}

export default forwardRef<MusicListType, { header?: ReactElement }>((props, ref) => {
  const { header } = props
  const listRef = useRef<OnlineListType>(null)
  const isUnmountedRef = useRef(false)
  // 2026-10-05 fix（P1-6）：请求序号，快速切榜时丢弃过期结果
  const loadIdRef = useRef(0)
  const handleListUpdate = useCallback((newList: LX.Music.MusicInfoOnline[]) => {
    if (isUnmountedRef.current) return
    boardState.listDetailInfo.list = newList
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      async loadList(source, id) {
        const loadId = ++loadIdRef.current
        const listDetailInfo = boardState.listDetailInfo
        // 切换榜单前先快照缓存列表：setList([]) 会经 onListUpdate 回写
        // boardState.listDetailInfo.list = []，不快照的话：
        // 1) 缓存命中分支永远失效（每次切回都重新请求整页）；
        // 2) 加载更多期间读到空列表会把页码错误地重置回 1，用第 1 页整表替换而非追加。
        const cachedList =
          listDetailInfo.id == id &&
          listDetailInfo.source == source &&
          listDetailInfo.list.length
            ? listDetailInfo.list
            : null
        // 刷新时机：冷启动后首次点开必刷，之后满 1 小时才再刷（core/refreshThrottle）
        const refreshNow = () => {
          if (!shouldRefreshByTtl(`boardSongs|${id}`)) return
          void getListDetail(id, 1, true)
            .then((listDetail) => {
              if (isUnmountedRef.current) return
              if (loadId !== loadIdRef.current) return
              const result = setListDetail(listDetail, id, 1)
              listRef.current?.setList(result.list)
              listRef.current?.setStatus(boardState.listDetailInfo.maxPage <= 1 ? 'end' : 'idle')
            })
            .catch(() => {})
        }
        listRef.current?.setList([])
        if (cachedList) {
          requestAnimationFrame(() => {
            listRef.current?.setList(cachedList)
          })
          refreshNow()
        } else {
          listRef.current?.setStatus('loading')
          const page = 1
          setListDetailInfo(id)
          // 首屏直接强制联网（榜单不缓存），并记录刷新时刻，避免紧接着再点一次又刷
          markRefreshed(`boardSongs|${id}`)
          return getListDetail(id, page, page === 1)
            .then((listDetail) => {
              // 高-3：守卫必须在写 store 之前——此前先 setListDetail 覆写共享
              // store 才查 loadId，切榜后迟到的旧榜数据已把新榜整表替换
              if (isUnmountedRef.current) return
              if (loadId !== loadIdRef.current) return
              const result = setListDetail(listDetail, id, page)
              requestAnimationFrame(() => {
                listRef.current?.setList(result.list)
                listRef.current?.setStatus(
                  boardState.listDetailInfo.maxPage <= page ? 'end' : 'idle',
                )
              })
            })
            .catch(() => {
              if (loadId !== loadIdRef.current) return
              if (boardState.listDetailInfo.list.length && page == 1) clearListDetail()
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

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    const listDetailInfo = boardState.listDetailInfo
    // console.log(boardState.listDetailInfo)
    void handlePlay(listDetailInfo.id, listDetailInfo.list, index)
  }
  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    const page = 1
    // 高-3：捕获发起时的榜 id 与代际，回调先验再写 store（此前裸奔，
    // 切榜后旧榜刷新结果会整表替换新榜）
    const id = boardState.listDetailInfo.id
    const loadId = loadIdRef.current
    listRef.current?.setStatus('refreshing')
    getListDetail(id, page, true)
      .then((listDetail) => {
        if (isUnmountedRef.current) return
        if (loadId !== loadIdRef.current || boardState.listDetailInfo.id !== id) return
        const result = setListDetail(listDetail, id, page)
        listRef.current?.setList(result.list)
        listRef.current?.setStatus(boardState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
        if (loadId !== loadIdRef.current || boardState.listDetailInfo.id !== id) return
        if (boardState.listDetailInfo.list.length && page == 1) clearListDetail()
        listRef.current?.setStatus('error')
      })
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    // 高-3：同 handleRefresh，捕获 id/代际，回调先验再写
    const id = boardState.listDetailInfo.id
    const loadId = loadIdRef.current
    listRef.current?.setStatus('loading')
    const page = boardState.listDetailInfo.list.length ? boardState.listDetailInfo.page + 1 : 1
    getListDetail(id, page)
      .then((listDetail) => {
        if (isUnmountedRef.current) return
        if (loadId !== loadIdRef.current || boardState.listDetailInfo.id !== id) return
        const result = setListDetail(listDetail, id, page)
        listRef.current?.setList(result.list, true)
        listRef.current?.setStatus(boardState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
        if (loadId !== loadIdRef.current || boardState.listDetailInfo.id !== id) return
        if (boardState.listDetailInfo.list.length && page == 1) clearListDetail()
        listRef.current?.setStatus('error')
      })
  }

  return (
    <OnlineList
      ref={listRef}
      ListHeaderComponent={header}
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      onListUpdate={handleListUpdate}
      checkHomePagerIdle
      rowType="medium"
    />
  )
})
