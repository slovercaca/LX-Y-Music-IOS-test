import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import PageTopInset from '@/components/common/PageTopInset'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import type { ActiveTab } from '../useWebDAVPage'

/**
 * WebDAV 页面顶部 Tab 栏（从旧 index.tsx 提取，行为不变）。
 */
const TabButton = memo(({ label, tab, activeTab, onPress }: {
  label: string
  tab: ActiveTab
  activeTab: ActiveTab
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{
        ...styles.tab,
        backgroundColor: activeTab === tab ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
        borderColor: activeTab === tab ? theme['c-primary'] : theme['c-border-background'],
      }}
      onPress={onPress}
    >
      <Text
        style={{
          ...styles.tabText,
          color: activeTab === tab ? theme['c-primary-light-1000'] : theme['c-font-label'],
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  )
})

export default memo(({ activeTab, onSelect }: {
  activeTab: ActiveTab
  onSelect: (tab: ActiveTab) => void
}) => {
  const theme = useTheme()
  return (
    <>
      <PageTopInset />
      <View style={{ ...styles.tabs, borderBottomColor: theme['c-border-background'] }}>
        <TabButton label="列表" tab="list" activeTab={activeTab} onPress={() => { onSelect('list') }} />
        <TabButton label="目录" tab="folders" activeTab={activeTab} onPress={() => { onSelect('folders') }} />
        <TabButton label={global.i18n.t('webdav_upload_tab')} tab="upload" activeTab={activeTab} onPress={() => { onSelect('upload') }} />
        <TabButton label="配置" tab="config" activeTab={activeTab} onPress={() => { onSelect('config') }} />
      </View>
    </>
  )
})

const styles = createStyle({
  tabs: {
    flexDirection: 'row',
    height: 44,
    paddingHorizontal: designSpacing.md,
    alignItems: 'center',
    gap: designSpacing.xs,
  },
  tab: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  tabText: {
    fontSize: designTypography.caption,
    fontWeight: '600',
  },
})
