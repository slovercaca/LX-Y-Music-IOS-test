import { memo } from 'react'

import Section from '../../components/Section'
import Source from './Source'
import SourceName from './SourceName'
import Language from './Language'
import FontSize from './FontSize'
import ShareType from './ShareType'
import IsAllowProgressBarSeek from './IsAllowProgressBarSeek'
import IsShowBackBtn from './IsShowBackBtn'
import IsShowExitBtn from './IsShowExitBtn'
import DrawerLayoutPosition from './DrawerLayoutPosition'
import IsStartupPushPlayDetailScreen from './IsStartupPushPlayDetailScreen'

export default memo(() => {
  return (
    <Section sectionId="setting_basic">
      {global.lx.isCarMode ? (
        <>
          <IsShowBackBtn />
          <IsShowExitBtn />
        </>
      ) : null}
      <IsAllowProgressBarSeek />
      {/* 低：该开关此前无引用——键被备份/同步写成 true 后每次启动都被推入
          全屏播放页且无处可关。补回渲染。 */}
      <IsStartupPushPlayDetailScreen />
      <DrawerLayoutPosition />
      <Language />
      <FontSize />
      <ShareType />
      <Source />
      <SourceName />
    </Section>
  )
})
