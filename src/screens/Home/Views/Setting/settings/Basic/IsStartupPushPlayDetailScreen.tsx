import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const startupPushPlayDetailScreen = useSettingValue('player.startupPushPlayDetailScreen')
  const setStartupPushPlayDetailScreen = (startupPushPlayDetailScreen: boolean) => {
    updateSetting({ 'player.startupPushPlayDetailScreen': startupPushPlayDetailScreen })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={startupPushPlayDetailScreen}
        label={t('setting_basic_startup_push_play_detail_screen')}
        helpDesc="开启后每次打开 App 会直接进入全屏播放页，而不是首页。"
        onChange={setStartupPushPlayDetailScreen}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
    // marginBottom: 15,
  },
})
