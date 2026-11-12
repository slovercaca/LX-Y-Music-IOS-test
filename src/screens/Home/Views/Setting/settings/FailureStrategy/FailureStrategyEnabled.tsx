import { memo } from 'react'

import CheckBoxItem from '../../components/CheckBoxItem'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'

// 失败策略总开关（2026-11-12）：关 = 下载/播放失败时只试首选一次，不跑任何策略步。
export default memo(() => {
  const t = useI18n()
  const enabled = useSettingValue('failureStrategy.enabled')

  return (
    <CheckBoxItem
      check={enabled}
      label={t('setting_failure_strategy_enabled')}
      onChange={(check) => { updateSetting({ 'failureStrategy.enabled': check }) }}
      helpDesc={t('setting_failure_strategy_enabled_tip')}
    />
  )
})
