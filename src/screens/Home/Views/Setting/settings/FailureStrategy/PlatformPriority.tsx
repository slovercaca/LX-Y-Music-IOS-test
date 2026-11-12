import { memo, useMemo } from 'react'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import OrderRow, { OrderList } from './OrderRow'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { PLATFORM_PRIORITY_SOURCES } from '@/core/music/failureStrategy'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

// 平台优先级（2026-11-12）：切换平台重试时，按此顺序逐个尝试其它平台的同名歌曲。
// 顺序值清洗与引擎侧 getFailureStrategyConfig 同口径（非法项过滤、缺项按默认补齐）。
const sanitizePriority = (value: unknown): LX.OnlineSource[] => {
  const list = Array.isArray(value) ? value.filter((v): v is LX.OnlineSource => (PLATFORM_PRIORITY_SOURCES as readonly string[]).includes(v as string)) : []
  const seen = new Set<LX.OnlineSource>()
  const out: LX.OnlineSource[] = []
  for (const v of list) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  for (const v of PLATFORM_PRIORITY_SOURCES) {
    if (!seen.has(v)) out.push(v)
  }
  return out
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const enabled = useSettingValue('failureStrategy.enabled')
  const rawPriority = useSettingValue('failureStrategy.platformPriority')
  const priority = useMemo(() => sanitizePriority(rawPriority), [rawPriority])

  const move = (id: LX.OnlineSource, dir: -1 | 1) => {
    const idx = priority.indexOf(id)
    const target = idx + dir
    if (idx === -1 || target < 0 || target >= priority.length) return
    const next = [...priority]
    next[idx] = priority[target]
    next[target] = id
    updateSetting({ 'failureStrategy.platformPriority': next })
  }

  return (
    <SubTitle title={t('setting_failure_strategy_platform_priority')}>
      <Text style={styles.tip} size={12} color={theme['c-font-label']}>
        {t('setting_failure_strategy_platform_priority_tip')}
      </Text>
      <OrderList>
        {priority.map((id, idx) => (
          <OrderRow
            key={id}
            label={t(`source_${id}`)}
            rank={idx + 1}
            onMoveUp={() => { move(id, -1) }}
            onMoveDown={() => { move(id, 1) }}
            disableUp={idx === 0}
            disableDown={idx === priority.length - 1}
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
