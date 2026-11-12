import { memo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { kickDownloadQueue } from '@/core/download'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

// 同时下载数量（2026-11-12）：下载队列 worker 数，1-6，默认 3；1 = 旧行为
//（严格串行一次下一首）。调大后立即泵送排队的任务，无需等当前任务跑完。
const Item = ({ value }: { value: number }) => {
  const t = useI18n()
  const concurrency = useSettingValue('download.concurrency')
  const isActive = concurrency === value
  return (
    <CheckBox
      block
      check={isActive}
      label={t('setting_download_concurrency_n', { n: value })}
      onChange={() => {
        updateSetting({ 'download.concurrency': value })
        kickDownloadQueue()
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()

  return (
    <SubTitle title={t('setting_download_concurrency')}>
      <Text style={styles.tip} size={12} color={theme['c-font-label']}>
        {t('setting_download_concurrency_tip')}
      </Text>
      <View>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <Item value={n} key={n} />
        ))}
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  tip: {
    marginBottom: designSpacing.sm,
  },
})
