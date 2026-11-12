import { memo } from 'react'
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { useSettingValue } from '@/store/setting/hook'
import { useAppActive } from '@/store/common/hook'

import GlassSurface from './GlassSurface'

export interface ContentGlassProps extends ViewProps {
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
   * 内部只接退后台门，不接 homeCovered：本容器也被 Dialog/Popup/PlayDetail
   * 内组件等非 Home 场景复用，homeCovered 在那些场景下会把可见玻璃误暂停
   * （useHomeCovered 的文档亦注明只用于挂在 Home 内的组件）。
   */
  paused?: boolean
}

/**
 * 内容区玻璃容器（2026-10-04）：列表项、首页卡片等内容组件用。
 *
 * 受设置 `theme.glassContent` 控制：
 * - 开：走 GlassSurface（与 tab 栏/弹窗同一套 LiquidGlass，液态/磨砂双形态）；
 * - 关：普通 View + fallbackBackgroundColor，即改动前的纯色外观。
 *
 * 调用方注意：开时不要再在 style 里带 backgroundColor（会被玻璃挡住，无意义）。
 */
const ContentGlass = memo(({ glassStyle, fallbackBackgroundColor, paused, style, children, ...props }: ContentGlassProps) => {
  const enabled = useSettingValue('theme.glassContent')
  // 5-6：App 退后台/锁屏时暂停玻璃的 Metal 渲染循环（与 ModernTabBar/
  // PlayerBar 的后台门同款口径）；退后台时没有任何玻璃可见，门控恒成立
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

ContentGlass.displayName = 'ContentGlass'

export default ContentGlass
