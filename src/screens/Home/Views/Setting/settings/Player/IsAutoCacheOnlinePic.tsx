import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

// 2026-10-22：自动缓存在线歌单封面。开启后 getPicPath 在线分支会把拿到的封面
// 落盘到下载目录 picture/（按下载文件名模板同名），各处控件优先读本地缓存。
export default memo(() => {
  const t = useI18n()
  const autoCacheOnlinePic = useSettingValue('player.autoCacheOnlinePic')
  const setAutoCacheOnlinePic = (check: boolean) => {
    updateSetting({ 'player.autoCacheOnlinePic': check })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={autoCacheOnlinePic}
        label={t('setting_player_auto_cache_online_pic')}
        onChange={setAutoCacheOnlinePic}
        helpDesc={t('setting_player_auto_cache_online_pic_tip')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
