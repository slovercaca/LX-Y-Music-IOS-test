import { getSongListSetting, saveSongListSetting } from '@/utils/data'
import { useEffect, useRef, useState, useCallback } from 'react'
import { StyleSheet, View, BackHandler } from 'react-native'
import { consumePendingAction } from '@/core/pendingAction'

import HeaderBar, { type HeaderBarProps, type HeaderBarType } from './HeaderBar'
import songlistState, { type InitState, type SortInfo, type ListInfoItem } from '@/store/songlist/state'
import List, { type ListType } from './List'
import SonglistDetail from '../../../SonglistDetail'
import { rememberHomeSubView, clearHomeSubView, takeRestorableSubView } from '@/core/homeSubView'
import commonState from '@/store/common/state'
import { useI18n } from '@/lang'
import MusicInfoOnline = LX.Music.MusicInfoOnline

interface SonglistInfo {
  source: InitState['sources'][number]
  sortId: SortInfo['id']
  tagId: string
}

export default () => {
  const headerBarRef = useRef<HeaderBarType>(null)
  const t = useI18n()
  const listRef = useRef<ListType>(null)
  const [selectedList, setSelectedList] = useState<ListInfoItem | null>(null)
  const [scrollToMusicInfo, setScrollToMusicInfo] = useState<MusicInfoOnline | null>(null)
  const selectedListRef = useRef(selectedList)
  selectedListRef.current = selectedList
  const songlistInfo = useRef<SonglistInfo>({ source: 'kw', sortId: '5', tagId: '' })
  const [headerKey, setHeaderKey] = useState(Date.now())
  // 5-4：首挂载标记——首屏加载由设置读取 effect 统一发，selectedList effect
  // 首挂载时跳过（否则首屏固定发两份 getList）
  const isFirstSelectedListEffectRef = useRef(true)
  // 5-4：HeaderBar 首次挂载标记——首挂载时不触发恢复（设置 effect 会调 setSource）
  const isFirstHeaderKeyRef = useRef(true)
  const loadList = useCallback(() => {
    listRef.current?.loadList(songlistInfo.current.source, songlistInfo.current.sortId, songlistInfo.current.tagId)
  }, [])

  // 退出恢复：上次停留在某张歌单详情时，进入本页直接把它打开（核心状态见 core/homeSubView）
  useEffect(() => {
    void takeRestorableSubView('nav_songlist').then((info) => {
      if (info) setSelectedList(info)
    })
  }, [])

  useEffect(() => {
    const onBackPress = () => {
      if (selectedListRef.current) {
        if (commonState.componentIds.length > 1) {
          return false
        }

        setSelectedList(null)
        clearHomeSubView()
        return true
      }

      return false
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress)
    return () => { subscription.remove() }
  }, [])

  useEffect(() => {
    void getSongListSetting().then((info) => {
      songlistInfo.current.source = info.source
      songlistInfo.current.sortId = info.sortId
      songlistInfo.current.tagId = info.tagId
      headerBarRef.current?.setSource(info.source, info.sortId, info.tagName, info.tagId)
      loadList()
    }).catch(() => {
      // 5-4：设置读取失败时仍用默认参数加载，避免首屏空白（首挂载的
      // selectedList effect 已不再兜底发请求）
      loadList()
    })
    // 中：headerKey 只作 HeaderBar 的 key、不进依赖——此前它一变（从详情
    // 返回时）本 effect 与下面的 effect 各调一次 loadList，双份请求，
    // 首份还可能用默认参数闪一帧错平台
  }, [loadList])

  useEffect(() => {
    // 5-4：首挂载时跳过——首屏加载只由上面的设置读取 effect 发一份 getList；
    // 从详情返回时（非首挂载）重载列表并刷新 HeaderBar。标记在首跑即消费，
    // 不受 selectedList 当前值影响（退出恢复场景首跑时 selectedList 也可能非空）
    const isFirst = isFirstSelectedListEffectRef.current
    isFirstSelectedListEffectRef.current = false
    if (!selectedList && !isFirst) {
      setHeaderKey(Date.now())
      loadList()
    }
  }, [selectedList, loadList])

  // 5-4：HeaderBar 重挂载（key 变化）后恢复高亮——此时 ref 已指向新实例，
  // 用 songlistInfo.current 的实际值恢复平台/分类/标签高亮；否则返回后
  // 三行全部停在默认值（kw/空/空），与实际列表脱节
  useEffect(() => {
    if (isFirstHeaderKeyRef.current) {
      isFirstHeaderKeyRef.current = false
      return
    }
    headerBarRef.current?.setSource(
      songlistInfo.current.source,
      songlistInfo.current.sortId,
      '',
      songlistInfo.current.tagId,
    )
  }, [headerKey])


  const handleSortChange: HeaderBarProps['onSortChange'] = (id) => {
    songlistInfo.current.sortId = id
    void saveSongListSetting({ sortId: id })
    listRef.current?.loadList(songlistInfo.current.source, id, songlistInfo.current.tagId)
  }

  const handleTagChange: HeaderBarProps['onTagChange'] = (name, id) => {
    songlistInfo.current.tagId = id
    void saveSongListSetting({ tagName: name, tagId: id })
    listRef.current?.loadList(songlistInfo.current.source, songlistInfo.current.sortId, id)
  }

  const handleSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    songlistInfo.current.source = source
    songlistInfo.current.tagId = ''
    // 汽水等仅支持「打开歌单链接」的平台没有 sortList，取空避免访问 [0].id 崩溃
    songlistInfo.current.sortId = songlistState.sortList[source]?.[0]?.id ?? ''
    void saveSongListSetting({
      sortId: songlistInfo.current.sortId,
      source,
      tagId: '',
      tagName: '',
    })
    headerBarRef.current?.setSource(
      source,
      songlistInfo.current.sortId,
      '',
      songlistInfo.current.tagId,
    )
    listRef.current?.loadList(source, songlistInfo.current.sortId, songlistInfo.current.tagId)
  }

  const handleOpenDetail = useCallback((item: ListInfoItem) => {
    setSelectedList(item)
    rememberHomeSubView(item, 'nav_songlist')
  }, [])

  const handleBack = useCallback(() => {
    setSelectedList(null)
    setScrollToMusicInfo(null)
    clearHomeSubView()
  }, [])

  useEffect(() => {
    const handleOpenImport = () => {
      // 1-21：经事件打开时也消费 pendingAction，避免它滞留到下次挂载时误触发
      consumePendingAction('songlistImport')
      (headerBarRef.current as any)?.setSource(
        songlistInfo.current.source,
        songlistInfo.current.sortId,
        '',
        songlistInfo.current.tagId,
      );
      (global.app_event as any).emit('_openSonglistModal', songlistInfo.current.source)
    }
    global.app_event.on('openSonglistImport', handleOpenImport)

    // 1-21：deeplink 切到本页时经导航事件消费 pendingAction，不再靠 100ms
    // 定时事件（deeplink/index.ts 已去掉定时；已在目标页时 deeplink 直接发事件）
    const handleNavChange = (id: string) => {
      if (id === 'nav_songlist' && consumePendingAction('songlistImport')) {
        handleOpenImport()
      }
    }
    global.state_event.on('navActiveIdUpdated', handleNavChange)

    if (consumePendingAction('songlistImport')) {
      setTimeout(() => { handleOpenImport() }, 300)
    }

    return () => {
      global.app_event.off('openSonglistImport', handleOpenImport)
      global.state_event.off('navActiveIdUpdated', handleNavChange)
    }
  }, [])

  return (
    <View style={styles.container}>
      <View style={[styles.baseContent, selectedList ? { opacity: 0 } : null]} pointerEvents={selectedList ? 'none' : 'auto'}>
        <List
          ref={listRef}
          header={(
            // 负边距抵消 Songlist 列表 FlatList 的 10pt 水平框架内边距，
            // 让平台/分类/标签横滑行的滚动范围直达屏幕左右两缘（与推荐页一致）
            <View style={{ marginHorizontal: -10 }}>
              <HeaderBar
                key={headerKey}
                ref={headerBarRef}
                title={t('discovery_tab_discover')}
                onSortChange={handleSortChange}
                onTagChange={handleTagChange}
                onSourceChange={handleSourceChange}
              />
            </View>
          )}
          onOpenDetail={handleOpenDetail}
        />
      </View>
      {selectedList ? (
        <View style={StyleSheet.absoluteFill}>
          <SonglistDetail info={selectedList} onBack={handleBack} initialScrollToInfo={scrollToMusicInfo} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flex: 1,
  },
  baseContent: {
    flex: 1,
  },
})
