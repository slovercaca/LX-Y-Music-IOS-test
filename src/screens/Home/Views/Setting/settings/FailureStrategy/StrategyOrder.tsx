import { memo, useMemo } from 'react'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import OrderRow, { OrderList } from './OrderRow'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { FAILURE_STEPS, type FailureStepId } from '@/core/music/failureStrategy'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

// 策略顺序（2026-11-12）：下载/播放失败时按此顺序依次重试；每步可单独开关。
// 顺序值清洗与引擎侧 getFailureStrategyConfig 同口径（非法项过滤、缺项按默认补齐）。
const sanitizeOrder = (value: unknown): FailureStepId[] => {
  const list = Array.isArray(value) ? value.filter((v): v is FailureStepId => (FAILURE_STEPS as readonly string[]).includes(v as string)) : []
  const seen = new Set<FailureStepId>()
  const out: FailureStepId[] = []
  for (const v of list) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  for (const v of FAILURE_STEPS) {
    if (!seen.has(v)) out.push(v)
  }
  return out
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const enabled = useSettingValue('failureStrategy.enabled')
  const rawOrder = useSettingValue('failureStrategy.order')
  const stepEnabled = useSettingValue('failureStrategy.stepEnabled')
  const order = useMemo(() => sanitizeOrder(rawOrder), [rawOrder])

  const move = (id: FailureStepId, dir: -1 | 1) => {
    const idx = order.indexOf(id)
    const target = idx + dir
    if (idx === -1 || target < 0 || target >= order.length) return
    const next = [...order]
    next[idx] = order[target]
    next[target] = id
    updateSetting({ 'failureStrategy.order': next })
  }

  const toggle = (id: FailureStepId, check: boolean) => {
    updateSetting({ 'failureStrategy.stepEnabled': { ...stepEnabled, [id]: check } })
  }

  return (
    <SubTitle title={t('setting_failure_strategy_order')}>
      <Text style={styles.tip} size={12} color={theme['c-font-label']}>
        {t('setting_failure_strategy_order_tip')}
      </Text>
      <OrderList>
        {order.map((id, idx) => (
          <OrderRow
            key={id}
            label={t(`setting_failure_strategy_step_${id}`)}
            checked={stepEnabled?.[id] !== false}
            onToggle={(check) => { toggle(id, check) }}
            onMoveUp={() => { move(id, -1) }}
            onMoveDown={() => { move(id, 1) }}
            disableUp={idx === 0}
            disableDown={idx === order.length - 1}
            disabled={!enabled}
          />
        ))}
      </OrderList>
    </SubTitle>
  )
})

const styles = createStyle({
  tip: {
    marginBottom: designSpacing.sm,
  },
})
