// screens/Home/Views/Setting/settings/Theme/ContentGlassToggle.tsx
// 内容区玻璃开关（2026-10-04）：列表项、首页卡片等内容区是否也用玻璃背景。
// 开 = ContentGlass 走 LiquidGlass（与 tab 栏/弹窗同一套，液态/磨砂双形态）；
// 关 = 各组件原来的纯色背景。实时生效（ContentGlass 内部订阅设置值）。
// 与 LiquidGlassToggle 不同：本开关全 iOS 版本显示（磨砂形态也有意义），不隐藏。

import { memo } from 'react'
import { View } from 'react-native'

import CheckBoxItem from '../../components/CheckBoxItem'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { designTypography } from '@/theme/DesignTokens'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const glassContent = useSettingValue('theme.glassContent')
  const setGlassContent = (enabled: boolean) => {
    updateSetting({ 'theme.glassContent': enabled })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={glassContent}
        label={t('setting_basic_theme_glass_content')}
        onChange={setGlassContent}
      />
      <Text style={styles.desc} color={theme['c-font-label']} size={designTypography.caption}>
        {t('setting_basic_theme_glass_content_desc')}
      </Text>
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
    marginBottom: 15,
  },
  desc: {
    lineHeight: 16,
  },
})
