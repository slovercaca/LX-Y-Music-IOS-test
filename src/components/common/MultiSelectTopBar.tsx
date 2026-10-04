import { memo, useCallback } from 'react'
import { View, TouchableOpacity } from 'react-native'

import Text from '@/components/common/Text'
import ContentGlass from '@/components/common/ContentGlass'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

/** 多选模式：单选 / 区间选择（与原 MultipleModeBar 一致） */
export type SelectMode = 'single' | 'range'

/** 顶部多选栏高度：按钮触摸目标 ≥44pt，栏本身 52pt */
export const MULTI_SELECT_TOP_BAR_HEIGHT = scaleSizeH(52)

export interface MultiSelectTopBarProps {
  /** 多选模式激活时显示 */
  visible: boolean
  selectMode: SelectMode
  /** 当前是否全选（受控：父组件维护） */
  isSelectAll: boolean
  onSwitchMode: (mode: SelectMode) => void
  /** 点击全选/反选：父组件负责调用 list.selectAll 并更新 isSelectAll */
  onSelectAll: (isAll: boolean) => void
  onExitSelectMode: () => void
  /** 在线列表用：批量下载选中歌曲；我的歌单不传则不显示下载按钮 */
  onDownload?: () => void
}

/**
 * 多选顶部操作栏（2026-10-04 Bug7：替代原 MultipleModeBar 悬浮窗）。
 *
 * 用户反馈悬浮窗过小，改为固定在列表顶部的操作栏，多选时显示：
 * 单选/区间切换 + 全选/反选 +（下载）+ 取消。
 * 背景走内容区玻璃开关（ContentGlass），按钮触摸目标 ≥44pt。
 */
const MultiSelectTopBar = memo(({
  visible,
  selectMode,
  isSelectAll,
  onSwitchMode,
  onSelectAll,
  onExitSelectMode,
  onDownload,
}: MultiSelectTopBarProps) => {
  const theme = useTheme()

  const handleSelectAll = useCallback(() => {
    onSelectAll(!isSelectAll)
  }, [isSelectAll, onSelectAll])

  if (!visible) return null

  const activeBg = { backgroundColor: theme['c-button-background'] }
  const inactiveBg = { backgroundColor: 'rgba(0,0,0,0)' }

  return (
    <ContentGlass
      glassStyle={{ borderRadius: 0 }}
      fallbackBackgroundColor={theme['c-content-background']}
      style={[styles.container, { borderBottomColor: theme['c-border-background'] }]}
    >
      <View style={styles.segment}>
        <TouchableOpacity
          onPress={() => { onSwitchMode('single') }}
          style={[styles.btn, selectMode === 'single' ? activeBg : inactiveBg]}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text color={theme['c-button-font']} numberOfLines={1}>{global.i18n.t('list_select_single')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { onSwitchMode('range') }}
          style={[styles.btn, selectMode === 'range' ? activeBg : inactiveBg]}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text color={theme['c-button-font']} numberOfLines={1}>{global.i18n.t('list_select_range')}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={handleSelectAll} style={styles.actionBtn}>
        <Text color={theme['c-button-font']} numberOfLines={1}>
          {global.i18n.t(isSelectAll ? 'list_select_unall' : 'list_select_all')}
        </Text>
      </TouchableOpacity>

      {onDownload ? (
        <TouchableOpacity onPress={onDownload} style={styles.actionBtn}>
          <Text color={theme['c-button-font']} numberOfLines={1}>{global.i18n.t('download')}</Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity onPress={onExitSelectMode} style={styles.actionBtn}>
        <Text color={theme['c-button-font']} numberOfLines={1}>{global.i18n.t('list_select_cancel')}</Text>
      </TouchableOpacity>
    </ContentGlass>
  )
})

MultiSelectTopBar.displayName = 'MultiSelectTopBar'

const styles = createStyle({
  container: {
    height: MULTI_SELECT_TOP_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.sm,
    borderBottomWidth: 1,
  },
  segment: {
    flexDirection: 'row',
    flex: 1.2,
    marginRight: designSpacing.xs,
  },
  // 所有按钮触摸目标 ≥44pt（2026-10-04 Bug7：原悬浮窗按钮过小）
  btn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: designRadius.sm,
    paddingHorizontal: designSpacing.xs,
  },
  actionBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: designSpacing.xs,
  },
})

export default MultiSelectTopBar
