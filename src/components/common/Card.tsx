import { memo, useMemo } from 'react'
import { StyleSheet, type ViewProps } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, type DesignSpacingToken } from '@/theme/DesignTokens'
import ContentGlass from './ContentGlass'

const styles = createStyle({
  base: {
    borderRadius: designRadius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
})

export interface CardProps extends ViewProps {
  padding?: DesignSpacingToken
}

export default memo(({ padding = 'md', style, ...props }: CardProps) => {
  const theme = useTheme()

  const cardStyle = useMemo(
    () => StyleSheet.compose(
      {
        ...styles.base,
        padding: designSpacing[padding],
        // 背景改由 ContentGlass 提供（2026-10-04 内容玻璃）：开关开 = 玻璃，
        // 开关关 = fallbackBackgroundColor 回退到原来的纯色。
        borderColor: theme['c-border-background'],
      },
      style,
    ),
    [padding, style, theme],
  )

  return (
    <ContentGlass
      glassStyle={{ borderRadius: designRadius.lg }}
      fallbackBackgroundColor={theme['c-content-background']}
      style={cardStyle}
      {...props}
    />
  )
})
