import { memo } from 'react'
import { Pressable, View } from 'react-native'

import Text from '@/components/common/Text'
import Checkbox from '@/components/common/CheckBox/Checkbox'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

interface RowProps {
  label: string
  /** 左侧勾选框（策略步骤行用；不传则不显示） */
  checked?: boolean
  onToggle?: (check: boolean) => void
  /** 左侧序号徽章（平台优先级行用；不传则不显示） */
  rank?: number
  onMoveUp: () => void
  onMoveDown: () => void
  disableUp?: boolean
  disableDown?: boolean
  disabled?: boolean
}

// 失败策略的可排序列表（2026-11-12）：样式与列表设置里的
// DiscoveryPlatformOrder 同一套（带边框的整体容器 + 行内 ↑/↓ 方形按钮，
// 上移/下移用文字字形 ↑/↓——IcoMoon 字体 53 个图标里没有上下箭头）。
export const OrderList = memo(({ children }: { children: React.ReactNode }) => {
  const theme = useTheme()
  return (
    <View style={{
      ...styles.content,
      backgroundColor: theme['c-primary-light-900-alpha-200'],
      borderColor: theme['c-border-background'],
    }}>
      {children}
    </View>
  )
})

export default memo(({
  label,
  checked,
  onToggle,
  rank,
  onMoveUp,
  onMoveDown,
  disableUp,
  disableDown,
  disabled = false,
}: RowProps) => {
  const theme = useTheme()
  const tintColors = {
    true: theme['c-primary'],
    false: theme['c-600'],
  }
  const disabledTintColors = {
    true: theme['c-primary-alpha-600'],
    false: theme['c-400'],
  }
  const upDisabled = disabled || disableUp
  const downDisabled = disabled || disableDown

  return (
    <View style={styles.row}>
      {onToggle !== undefined && checked !== undefined ? (
        <Checkbox
          status={checked ? 'checked' : 'unchecked'}
          disabled={disabled}
          onPress={() => { onToggle(!checked) }}
          tintColors={disabled ? disabledTintColors : tintColors}
        />
      ) : null}
      {rank !== undefined ? (
        <View style={[styles.badge, { backgroundColor: theme['c-primary-background'] }]}>
          <Text size={12} color={theme['c-font-label']}>{rank}</Text>
        </View>
      ) : null}
      <View style={styles.labelRow}>
        <Text
          style={styles.label}
          size={15}
          color={disabled ? theme['c-500'] : theme['c-font']}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
      <Pressable
        hitSlop={6}
        style={[styles.actionBtn, { borderColor: theme['c-border-background'] }, upDisabled ? styles.actionDisabled : null]}
        disabled={upDisabled}
        onPress={onMoveUp}
        accessibilityRole="button"
      >
        <Text size={14} color={upDisabled ? theme['c-350'] : theme['c-font']}>↑</Text>
      </Pressable>
      <Pressable
        hitSlop={6}
        style={[styles.actionBtn, { borderColor: theme['c-border-background'] }, downDisabled ? styles.actionDisabled : null]}
        disabled={downDisabled}
        onPress={onMoveDown}
        accessibilityRole="button"
      >
        <Text size={14} color={downDisabled ? theme['c-350'] : theme['c-font']}>↓</Text>
      </Pressable>
    </View>
  )
})

const styles = createStyle({
  content: {
    borderWidth: 1,
    borderRadius: designRadius.md,
    padding: designSpacing.sm,
    gap: designSpacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: designSpacing.sm,
  },
  badge: {
    minWidth: 26,
    height: 26,
    borderRadius: designRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  labelRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: designSpacing.xs,
  },
  label: {
    flexShrink: 1,
    fontWeight: '600',
  },
  actionBtn: {
    width: 30,
    height: 30,
    borderRadius: designRadius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDisabled: {
    opacity: 0.4,
  },
})
