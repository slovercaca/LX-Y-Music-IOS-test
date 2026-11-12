import { memo } from 'react'

import Section from '../../components/Section'
import FailureStrategyEnabled from './FailureStrategyEnabled'
import StrategyOrder from './StrategyOrder'
import PlatformPriority from './PlatformPriority'
import QualityDirection from './QualityDirection'

// 失败策略（2026-11-12）：下载/播放失败时按用户排序自动重试。
// 引擎见 src/core/music/failureStrategy.ts + src/core/music/utils.ts。
export default memo(() => {
  return (
    <Section sectionId="setting_failure_strategy">
      <FailureStrategyEnabled />
      <StrategyOrder />
      <PlatformPriority />
      <QualityDirection />
    </Section>
  )
})
