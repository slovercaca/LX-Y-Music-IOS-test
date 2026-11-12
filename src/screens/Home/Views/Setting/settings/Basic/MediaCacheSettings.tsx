import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

// 2026-11-12：歌词/封面缓存策略（三开关，见 utils/localLibrary.ts 的策略注释）。
// 总开关关 = 不进行歌词和封面的任何缓存（在线获取的只在内存显示一次、用完即弃，
// 已缓存的文件不受影响）；总开关关闭时两个分开关置灰、值保持不变，重开总开关
// 后恢复原来的分开关状态。
export default memo(() => {
  const t = useI18n()
  const mediaCacheEnabled = useSettingValue('player.mediaCacheEnabled')
  const mediaCacheLyric = useSettingValue('player.mediaCacheLyric')
  const mediaCachePic = useSettingValue('player.mediaCachePic')

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={mediaCacheEnabled}
        label={t('setting_basic_media_cache_enabled')}
        onChange={(check) => { updateSetting({ 'player.mediaCacheEnabled': check }) }}
        helpDesc={t('setting_basic_media_cache_enabled_tip')}
      />
      <CheckBoxItem
        check={mediaCacheLyric}
        label={t('setting_basic_media_cache_lyric')}
        onChange={(check) => { updateSetting({ 'player.mediaCacheLyric': check }) }}
        helpDesc={t('setting_basic_media_cache_lyric_tip')}
        disabled={!mediaCacheEnabled}
      />
      <CheckBoxItem
        check={mediaCachePic}
        label={t('setting_basic_media_cache_pic')}
        onChange={(check) => { updateSetting({ 'player.mediaCachePic': check }) }}
        helpDesc={t('setting_basic_media_cache_pic_tip')}
        disabled={!mediaCacheEnabled}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
