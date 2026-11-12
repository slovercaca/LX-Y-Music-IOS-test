import { memo } from 'react'
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { useSettingValue } from '@/store/setting/hook'
import { useAppActive } from '@/store/common/hook'

import GlassSurface from './GlassSurface'

export interface UtilityGlassProps extends ViewProps {
  /**
   * 透传给 LiquidGlass 的样式（通常只放圆角），开关开时生效。
   */
  glassStyle?: StyleProp<ViewStyle>
  /**
   * 开关关闭时的回退背景色——填该组件**原来**的 backgroundColor，
   * 关开关即原样恢复旧外观。
   */
  fallbackBackgroundColor?: string
  /**
   * 5-6：省电门——调用方传入的 paused 与内部「App 退后台」门取或后透传给玻璃。
   * 内部只接退后台门，不接 homeCovered（同 ContentGlass：本容器也被 Menu 等
   * 非 Home 场景复用，homeCovered 会把可见玻璃误暂停）。
   */
  paused?: boolean
}

/**
 * 浮动工具玻璃容器（2026-10-04）：多选模式悬浮条、「…」菜单等浮动工具 UI 用。
 *
 * 受设置 `theme.glassUtility` 控制（与内容区玻璃独立）：
 * - 开：走 GlassSurface（与 tab 栏/弹窗同一套 LiquidGlass，液态/磨砂双形态）；
 * - 关：普通 View + fallbackBackgroundColor，即改动前的纯色外观。
 */
const UtilityGlass = memo(({ glassStyle, fallbackBackgroundColor, paused, style, children, ...props }: UtilityGlassProps) => {
  const enabled = useSettingValue('theme.glassUtility')
  // 5-6：App 退后台/锁屏时暂停玻璃的 Metal 渲染循环（同 ContentGlass）
  const appActive = useAppActive()

  if (!enabled) {
    return (
      <View
        style={[style, fallbackBackgroundColor ? { backgroundColor: fallbackBackgroundColor } : null]}
        {...props}
      >
        {children}
      </View>
    )
  }

  return (
    <GlassSurface glassStyle={glassStyle} style={style} paused={paused || !appActive} {...props}>
      {children}
    </GlassSurface>
  )
})

UtilityGlass.displayName = 'UtilityGlass'

export default UtilityGlass
