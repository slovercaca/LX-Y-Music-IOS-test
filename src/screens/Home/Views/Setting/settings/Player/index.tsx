import { memo } from 'react'

import Section from '../../components/Section'
import IsSavePlayTime from './IsSavePlayTime'
import PlayHighQuality from './PlayHighQuality'
import IsHandleAudioFocus from './IsHandleAudioFocus'
import IsEnableAudioOffload from './IsEnableAudioOffload'
import IsEnableAudioPreload from './IsEnableAudioPreload'
import UseNativeFlacPlayer from './UseNativeFlacPlayer'
import IsAutoCleanPlayedList from './IsAutoCleanPlayedList'
import IsAutoSkipOnError from './IsAutoSkipOnError'
import IsShowLyricTranslation from './IsShowLyricTranslation'
import IsShowLyricRoma from './IsShowLyricRoma'
import IsShowBluetoothLyric from './IsShowBluetoothLyric'
import IsS2T from './IsS2T'
import ClearCache from './ClearCache'
import IsAutoPlayOnStartup from './IsAutoPlayOnStartup'
import IsShowNotificationImage from './IsShowNotificationImage'

export default memo(() => {
  return (
    <Section sectionId="setting_player">
      <IsSavePlayTime />
      <IsAutoPlayOnStartup />
      {/* 2026-11-12：旧「自动缓存在线歌单的封面」已并入基础设置的歌词/封面
          缓存策略（三开关），旧键值在启动时迁移到 player.mediaCachePic */}
      <IsAutoCleanPlayedList />
      <IsAutoSkipOnError />
      <IsHandleAudioFocus />
      <IsEnableAudioOffload />
      <IsEnableAudioPreload />
      <UseNativeFlacPlayer />
      <IsShowLyricTranslation />
      <IsShowLyricRoma />
      <IsShowBluetoothLyric />
      <IsS2T />
      {/* 低：该开关组件此前无任何引用——键被导入/同步写成 false 后锁屏与
          通知栏封面永不显示且界面无解。补回渲染。 */}
      <IsShowNotificationImage />
      <ClearCache />
      <PlayHighQuality />
    </Section>
  )
})
