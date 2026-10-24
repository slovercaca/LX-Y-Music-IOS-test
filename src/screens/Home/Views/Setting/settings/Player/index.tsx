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
import IsAutoCacheOnlinePic from './IsAutoCacheOnlinePic'
import IsShowNotificationImage from './IsShowNotificationImage'

export default memo(() => {
  return (
    <Section sectionId="setting_player">
      <IsSavePlayTime />
      <IsAutoPlayOnStartup />
      <IsAutoCacheOnlinePic />
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
