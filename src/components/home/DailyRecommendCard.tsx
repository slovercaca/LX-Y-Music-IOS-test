import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { SvgIcon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import ContentGlass from '@/components/common/ContentGlass'

interface DailyRecommendCardProps {
  title: string
  subtitle: string
  onPress: () => void
}

const styles = createStyle({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 72,
    paddingHorizontal: designSpacing.md,
    borderRadius: designRadius.md,
  },
  iconContent: {
    width: 44,
    height: 44,
    borderRadius: designRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    paddingLeft: designSpacing.sm,
  },
  title: {
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 2,
  },
})

const DailyRecommendCard = memo(({ title, subtitle, onPress }: DailyRecommendCardProps) => {
  const theme = useTheme()

  const cardStyle = useMemo(
    () => StyleSheet.compose(styles.card, {
      // 背景改由 ContentGlass 提供（2026-10-04 内容玻璃）。
    }),
    [],
  )

  const iconContentStyle = useMemo(
    () => StyleSheet.compose(styles.iconContent, {
      backgroundColor: theme['c-primary'],
    }),
    [theme],
  )

  return (
    <Pressable onPress={onPress} style={{ borderRadius: designRadius.md }}>
      <ContentGlass
        glassStyle={{ borderRadius: designRadius.md }}
        fallbackBackgroundColor={theme['c-primary-light-900-alpha-300']}
        style={cardStyle}
      >
        <View style={iconContentStyle}>
          <SvgIcon name="calendar" size={22} color={theme['c-primary-light-1000']} />
        </View>
        <View style={styles.content}>
          <Text style={styles.title} size={designTypography.title} color={theme['c-font']}>
            {title}
          </Text>
          <Text style={styles.subtitle} size={designTypography.body} color={theme['c-font-label']} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </ContentGlass>
    </Pressable>
  )
})
DailyRecommendCard.displayName = 'HomeDailyRecommendCard'
export default DailyRecommendCard
