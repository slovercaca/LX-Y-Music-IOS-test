import { useCallback, useEffect, useRef } from 'react'
import { filterList, getHotComment } from './utils'
import music from '@/utils/musicSdk'
import List, { type ListType } from './components/List'
import { type CommentFloorActions } from './components/CommentFloor'
const limit = 15

export default ({
  musicInfo,
  onUpdateTotal,
  actions,
  refreshKey,
}: {
  musicInfo: LX.Music.MusicInfoOnline
  onUpdateTotal: (total: number) => void
  actions?: CommentFloorActions
  refreshKey?: number
}) => {
  // const [isLoading, setIsLoading] = useState(false)
  const listRef = useRef<ListType>(null)
  // 中：请求序号——切歌/刷新交叠时，旧歌的迟到结果不得覆写新歌的
  // 列表与分页游标（此前全无守卫，旧评论整表覆盖、page 被倒退）
  const requestSeqRef = useRef(0)
  const listInfo = useRef({
    page: 1,
    total: 0,
    maxPage: 1,
    isEnd: false,
    isLoading: false,
    isLoadError: false,
  })
  const handleGetComment = async(musicInfo: LX.Music.MusicInfoOnline, page: number, seq: number) => {
    // setIsLoading(true)
    listInfo.current.isLoading = true
    return getHotComment(musicInfo, page, limit)
      .then((commentInfo) => {
        // 过期请求：借用既有「取消请求」约定中止，不碰新请求的分页/加载态
        if (seq !== requestSeqRef.current) throw new Error('取消请求')
        listInfo.current.page = page
        listInfo.current.isLoading = false
        // setIsLoading(false)
        if (listInfo.current.isLoadError) {
          listInfo.current.isLoadError = false
        }
        return commentInfo
      })
      .catch(async(err) => {
        console.log(err)
        if (err.message != '取消请求') {
          listInfo.current.isLoading = false
          // setIsLoading(false)
          listInfo.current.isLoadError = true
        }
        throw err
      })
  }
  const updateStatus = () => {
    if (listInfo.current.isLoadError) {
      listRef.current?.setStatus('error')
    } else if (listInfo.current.isEnd) {
      listRef.current?.setStatus('end')
    } else if (!listInfo.current.isLoading) {
      listRef.current?.setStatus('idle')
    }
  }
  const handleListLoadMore = () => {
    if (listInfo.current.isLoading || listInfo.current.isEnd) return
    const list = listRef.current?.getList() ?? []
    const page = list.length ? listInfo.current.page + 1 : 1
    listRef.current?.setStatus('loading')
    void handleGetComment(musicInfo, page, requestSeqRef.current)
      .then(({ comments }) => {
        let isEnd = page >= listInfo.current.maxPage
        if (listInfo.current.isEnd != isEnd) listInfo.current.isEnd = isEnd
        listRef.current?.setList(filterList([...listRef.current.getList(), ...comments]))
      })
      .finally(updateStatus)
  }

  const handleListRefresh = useCallback(() => {
    listRef.current?.setStatus('refreshing')
    void handleGetComment(musicInfo, 1, ++requestSeqRef.current)
      .then(({ comments, maxPage, total }) => {
        listInfo.current.total = total
        listInfo.current.maxPage = maxPage
        onUpdateTotal(total)
        let isEnd = maxPage === 1
        if (listInfo.current.isEnd != isEnd) listInfo.current.isEnd = isEnd
        listRef.current?.setList(filterList(comments))
      })
      .finally(updateStatus)
  }, [musicInfo, onUpdateTotal])

  const handleShowComment = useCallback((musicInfo: LX.Music.MusicInfoOnline) => {
    if (!musicInfo.id || !(music[musicInfo.source])?.comment) return
    listInfo.current.page = 1
    listInfo.current.total = 0
    listInfo.current.maxPage = 1
    listInfo.current.isEnd = false
    listInfo.current.isLoading = false
    listInfo.current.isLoadError = false
    listRef.current?.setList([])
    listRef.current?.setStatus('loading')
    const seq = ++requestSeqRef.current
    void handleGetComment(musicInfo, 1, seq).then(({ comments, maxPage, total }) => {
      if (seq !== requestSeqRef.current) return
      listInfo.current.total = total
      listInfo.current.maxPage = maxPage
      onUpdateTotal(total)
      let isEnd = maxPage === 1
      if (listInfo.current.isEnd != isEnd) listInfo.current.isEnd = isEnd
      setTimeout(() => {
        if (seq !== requestSeqRef.current) return
        listRef.current?.setList(filterList(comments))
        setTimeout(updateStatus, 300)
      }, 300)
    }).catch(() => {
      if (seq !== requestSeqRef.current) return // 过期请求的失败不拨新歌的状态机
      // P0 修复：首屏请求失败时必须把状态机拨到 'error'，否则永远停在 'loading'
      // 无限转圈，"出错点我重试" 的 Footer 永远出不来。
      listRef.current?.setStatus('error')
    })
  }, [onUpdateTotal])

  useEffect(() => {
    handleShowComment(musicInfo)
  }, [handleShowComment, musicInfo])

  // Force refresh when refreshKey changes (after send/delete)
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    handleListRefresh()
  }, [refreshKey, handleListRefresh])

  return <List ref={listRef} onLoadMore={handleListLoadMore} onRefresh={handleListRefresh} actions={actions} />
}
