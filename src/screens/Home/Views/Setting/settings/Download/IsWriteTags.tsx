import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  // const isEnable = useSettingValue('download.enable')
  const isWriteTags = useSettingValue('download.writeMetadata')
  const handleUpdate = (isWriteTags: boolean) => {
    updateSetting({ 'download.writeMetadata': isWriteTags })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isWriteTags}
        onChange={handleUpdate}
        label={t('setting_download_write_metadata')}
        helpDesc="把歌名、歌手、专辑等信息写入歌曲文件的标签（元数据），其他播放器和文件管理器能正确识别。只影响之后下载的歌曲。"
        // disabled={!isEnable}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
