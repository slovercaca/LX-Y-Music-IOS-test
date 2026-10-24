import { memo, useEffect, useRef, useState } from 'react'
import { View, AppState, Dimensions, Platform, PixelRatio } from 'react-native'
import { screenkeepAwake, screenUnkeepAwake, getCutoutLeftPx } from '@/utils/nativeModules/utils'
import StatusBar from '@/components/common/StatusBar'
import MoreBtn from './MoreBtn'
import Header from './components/Header'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import PageContent from '@/components/PageContent'
import commonState, { type InitState as CommonState } from '@/store/common/state'

import Pic from './Pic'
// import ControlBtn from './ControlBtn'
import Lyric from './Lyric'
import Player from './Player'
import { createStyle } from '@/utils/tools'
import { marginLeftRaw } from './constant'
import { useStatusbarHeight } from '@/store/common/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useLandscapeLayout } from '@/utils/landscapeLayout'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist.tsx'

const useCutoutLeft = () => {
  const [cutoutLeftDp, setCutoutLeftDp] = useState(() => {
    if (Platform.OS === 'ios') return 0
    const screen = Dimensions.get('screen')
    const win = Dimensions.get('window')
    return Math.max(0, screen.width - win.width)
  })

  useEffect(() => {
    if (Platform.OS === 'ios') return
    const update = () => {
      void getCutoutLeftPx().then((px: number) => {
        setCutoutLeftDp(px > 0 ? Math.round(px / PixelRatio.get()) : 0)
      })
    }
    update()
    const sub = Dimensions.addEventListener('change', update)
    return () => { sub?.remove() }
  }, [])

  return cutoutLeftDp
}

export default memo(({ componentId }: { componentId: string }) => {
  const playlistRef = useRef<PlayerPlaylistType>(null)
  const statusBarHeight = useStatusbarHeight()
  const isLandscapeStretch = useSettingValue('theme.isLandscapeStretch')
  const layout = useLandscapeLayout()
  const rawCutoutLeft = useCutoutLeft()
  const cutoutLeft = isLandscapeStretch ? 0 : rawCutoutLeft

  useEffect(() => {
    setComponentId(COMPONENT_IDS.playDetail, componentId)
    screenkeepAwake()
    // 低-33：componentIds 是 {name} 数组，此前按对象读 .comment 恒 undefined——
    // 横屏打开评论页后常亮判断全错位（竖屏 VerticalNew 用的是 find 写法）
    const hasCommentPage = (ids: CommonState['componentIds']) =>
      ids.find(item => item.name === COMPONENT_IDS.comment)
    let appstateListener = AppState.addEventListener('change', (state) => {
      switch (state) {
        case 'active':
          if (!hasCommentPage(commonState.componentIds)) screenkeepAwake()
          break
        case 'background':
          screenUnkeepAwake()
          break
      }
    })

    const handleComponentIdsChange = (ids: CommonState['componentIds']) => {
      if (hasCommentPage(ids)) screenUnkeepAwake()
      else if (AppState.currentState == 'active') screenkeepAwake()
    }

    global.state_event.on('componentIdsUpdated', handleComponentIdsChange)

    // 中-1：横屏此前没挂队列面板也没监听 showPlaylist——迷你条/详情页的队列
    // 按钮在横屏点了只跳详情、队列永不弹（竖屏 VerticalNew 有同款实现）
    const handleShowPlaylist = () => { playlistRef.current?.show() }
    global.app_event.on('showPlaylist', handleShowPlaylist)

    return () => {
      global.state_event.off('componentIdsUpdated', handleComponentIdsChange)
      global.app_event.off('showPlaylist', handleShowPlaylist)
      appstateListener.remove()
      screenUnkeepAwake()
    }
  }, [componentId])

  return (
    <PageContent>
      <StatusBar />
      <View style={{ ...styles.container, paddingTop: statusBarHeight }}>
        <View style={{ ...styles.left, width: `${layout.leftRatio * 100}%`, marginLeft: cutoutLeft }}>
          <Header componentId={componentId} />
          <View style={styles.leftContent}>
            <MoreBtn />
            <Pic componentId={componentId} />
          </View>
          <Player />
          {/* <View style={styles.controlBtn} nativeID="pageIndicator">
            <MoreBtn />
            <ControlBtn />
          </View> */}
        </View>
        <View style={{ ...styles.right, width: `${layout.rightRatio * 100}%`, maxWidth: Number.isFinite(layout.lyricMaxWidth) ? layout.lyricMaxWidth : undefined }}>
          <Lyric />
        </View>
      </View>
      <PlayerPlaylist ref={playlistRef} />
    </PageContent>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  left: {
    flex: 1,
    width: '45%',
    paddingBottom: 10,
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
  leftContent: {
    flex: 1,
    marginLeft: marginLeftRaw,
    justifyContent: 'center',
    position: 'relative',
  },
  miniLyricContainer: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  right: {
    width: '55%',
    flexGrow: 0,
    flexShrink: 0,
  },
  controlBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // backgroundColor: '#eee',
  },
})
