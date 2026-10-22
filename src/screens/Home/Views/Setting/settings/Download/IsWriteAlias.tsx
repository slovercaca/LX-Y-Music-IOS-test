import { memo } from 'react'
import { View } from 'react-native'
import CheckBoxItem from '../../components/CheckBoxItem'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'

export default memo(() => {
  const t = useI18n()
  const isWriteAlias = useSettingValue('download.writeAlias')
  const isWriteTags = useSettingValue('download.writeMetadata')
  const handleUpdate = (value: boolean) => {
    updateSetting({ 'download.writeAlias': value })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isWriteAlias}
        onChange={handleUpdate}
        label={t('setting_download_write_alias')}
        helpDesc="把歌手/歌曲的别名写入歌曲文件的标签里，其他播放器里也能看到别名。只影响之后下载的歌曲。"
        disabled={!isWriteTags}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
