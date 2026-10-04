// screens/Home/Views/Setting/settings/Theme/UtilityGlassToggle.tsx
// 浮动工具玻璃开关（2026-10-04）：多选模式悬浮条、「…」菜单等浮动工具 UI
// 是否使用玻璃背景。与内容区玻璃开关独立控制，全 iOS 版本显示。

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
  const glassUtility = useSettingValue('theme.glassUtility')
  const setGlassUtility = (enabled: boolean) => {
    updateSetting({ 'theme.glassUtility': enabled })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={glassUtility}
        label={t('setting_basic_theme_glass_utility')}
        onChange={setGlassUtility}
      />
      <Text style={styles.desc} color={theme['c-font-label']} size={designTypography.caption}>
        {t('setting_basic_theme_glass_utility_desc')}
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
