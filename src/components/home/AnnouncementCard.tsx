import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import ContentGlass from '@/components/common/ContentGlass'

interface AnnouncementCardProps {
  title: string
  message: string
}

const styles = createStyle({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: designSpacing.md,
    borderRadius: designRadius.lg,
    borderWidth: 1,
  },
  iconContent: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    paddingLeft: designSpacing.md,
  },
  title: {
    fontWeight: '700',
  },
  message: {
    marginTop: 3,
  },
})

const AnnouncementCard = memo(({ title, message }: AnnouncementCardProps) => {
  const theme = useTheme()

  const cardStyle = useMemo(
    () => StyleSheet.compose(styles.card, {
      // 背景改由 ContentGlass 提供（2026-10-04 内容玻璃）：开关开 = 玻璃，
      // 开关关 = fallbackBackgroundColor 回退到原来的纯色。
      borderColor: theme['c-primary-alpha-500'],
    }),
    [theme],
  )

  const iconContentStyle = useMemo(
    () => StyleSheet.compose(styles.iconContent, {
      backgroundColor: theme['c-primary'],
    }),
    [theme],
  )

  return (
    <ContentGlass
      glassStyle={{ borderRadius: designRadius.lg }}
      fallbackBackgroundColor={theme['c-primary-light-900-alpha-200']}
      style={cardStyle}
    >
      <View style={iconContentStyle}>
        <Icon name="album" size={26} color={theme['c-primary-light-1000']} />
      </View>
      <View style={styles.content}>
        <Text style={styles.title} size={designTypography.body} color={theme['c-primary-dark-100']}>
          {title}
        </Text>
        <Text
          style={styles.message}
          size={designTypography.caption}
          color={theme['c-font-label']}
          numberOfLines={1}
        >
          {message}
        </Text>
      </View>
    </ContentGlass>
  )
})
AnnouncementCard.displayName = 'HomeAnnouncementCard'
export default AnnouncementCard
