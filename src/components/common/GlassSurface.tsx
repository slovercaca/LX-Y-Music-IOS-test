import { memo, useMemo } from 'react'
import { View, StyleSheet, type StyleProp, type ViewProps, type ViewStyle } from 'react-native'

import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { isIOS26_2OrAbove } from '@/utils/tools'

import LiquidGlass from './LiquidGlass'

export interface GlassSurfaceProps extends ViewProps {
  /**
   * 透传给 LiquidGlass 的样式（通常只放圆角）。
   * LiquidGlass 内部是 absoluteFill + compose：可覆盖 bottom 等定位值——
   * 传 `bottom: -safeAreaBottom` 能让玻璃延伸出容器底部（Popup 底部安全区即用此法，
   * 一块玻璃无缝覆盖面板 + 安全区，无需第二个玻璃视图拼缝）。
   */
  glassStyle?: StyleProp<ViewStyle>
  /**
   * 省电门：所在屏幕被压栈页完全覆盖时暂停 Metal 逐帧渲染。
   * Dialog / Popup / Menu 这类浮层显示即可见、隐藏即卸载，默认 false 即可；
   * 常驻组件（tab 栏等）按需传入 useHomeCovered / useScreenCovered 的判定结果。
   */
  paused?: boolean
}

/**
 * 全局玻璃浮层容器（2026-10-04：液态玻璃作用至全局）。
 *
 * 背景用 LiquidGlass（液态/磨砂双形态：26.2+ 兜底、深色可读性保底都在其内部），
 * 内容盖在上层。主题参数（theme.glassOpacity / theme.liquidGlass / theme.isDark）
 * 内部自行读取，调用方只管布局 + 圆角。
 *
 * ⚠️ 不要再给容器设 backgroundColor——纯色背景会挡住玻璃的折射/模糊，
 * 玻璃本身就是背景。玻璃圆角走 glassStyle（直接裁原生视图），容器自身的
 * borderRadius 只影响边框与子内容裁剪。
 */
const GlassSurface = memo(({ glassStyle, paused = false, style, children, ...props }: GlassSurfaceProps) => {
  const theme = useTheme()
  // 与 ModernTabBar / PlayerBar 同一套参数口径（2026-09-28 定案）。
  const glassOpacity = useSettingValue('theme.glassOpacity') / 100
  const liquidGlassOn = useSettingValue('theme.liquidGlass') && !isIOS26_2OrAbove

  // 2026-10-05 fix（P1-1）：用 StyleSheet.flatten 替代手动展平——
  // createStyle 返回的是 StyleSheet.create() 的数字注册 ID，{...123} 会丢样式。
  // flatten 能正确解析数字 ID、数组、嵌套数组。
  const safeStyle = useMemo(() => {
    if (!style) return style
    const flat = StyleSheet.flatten(style)
    if (flat && 'backgroundColor' in flat) {
      const { backgroundColor, ...rest } = flat
      return rest
    }
    return flat
  }, [style])

  return (
    <View style={safeStyle} {...props}>
      <LiquidGlass
        glassOpacity={glassOpacity}
        dark={theme.isDark}
        liquid={liquidGlassOn}
        paused={paused}
        style={glassStyle}
      />
      {children}
    </View>
  )
})

GlassSurface.displayName = 'GlassSurface'

export default GlassSurface
