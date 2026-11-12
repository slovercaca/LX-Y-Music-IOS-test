import { memo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

// 音质重试方向（2026-11-12）：换音质重试时，从首选档位一档一档往下降或往上升。
const Item = ({ id, name, disabled }: { id: 'down' | 'up', name: string, disabled: boolean }) => {
  const direction = useSettingValue('failureStrategy.qualityDirection')
  const isActive = direction === id
  return (
    <CheckBox
      block
      check={isActive}
      label={name}
      onChange={() => {
        updateSetting({ 'failureStrategy.qualityDirection': id })
      }}
      disabled={disabled}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const enabled = useSettingValue('failureStrategy.enabled')

  return (
    <SubTitle title={t('setting_failure_strategy_quality_direction')}>
      <Text style={styles.tip} size={12} color={theme['c-font-label']}>
        {t('setting_failure_strategy_quality_direction_tip')}
      </Text>
      <View>
        <Item id="down" name={t('setting_failure_strategy_quality_down')} disabled={!enabled} />
        <Item id="up" name={t('setting_failure_strategy_quality_up')} disabled={!enabled} />
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  tip: {
    marginBottom: designSpacing.sm,
  },
})
