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
  const isWriteEmbedLyrics = useSettingValue('download.writeEmbedLyric')
  const handleUpdate = (isWriteEmbedLyrics: boolean) => {
    updateSetting({ 'download.writeEmbedLyric': isWriteEmbedLyrics })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isWriteEmbedLyrics}
        onChange={handleUpdate}
        label={t('setting_download_write_embed_lyric')}
        helpDesc="把歌词直接写进歌曲文件内部（内嵌歌词），文件拷到其他播放器也能显示歌词。与「下载歌词文件」是两回事：那个是单独的 .lrc 文件。"
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
