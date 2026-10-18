import { memo, useCallback } from 'react'
import { TouchableOpacity } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { toast, createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

/**
 * 离线模式开关（2026-10-18）。
 * 开启后播放时优先使用本地已下载文件，封面优先用本地缓存。
 * 用于歌单顶部，让用户在无网络时也能播放已下载的歌曲。
 */
export default memo(() => {
  const theme = useTheme()
  const offlineMode = useSettingValue('player.offlineMode')

  const toggle = useCallback(() => {
    const next = !offlineMode
    updateSetting({ 'player.offlineMode': next })
    toast(next ? '已进入离线模式，将优先播放本地已下载歌曲' : '已退出离线模式')
  }, [offlineMode])

  return (
    <TouchableOpacity
      style={[
        styles.container,
        {
          backgroundColor: offlineMode ? theme['c-primary'] : theme['c-button-background'],
        },
      ]}
      activeOpacity={0.7}
      onPress={toggle}
    >
      <Icon
        name="download"
        size={14}
        color={offlineMode ? theme['c-primary-light-1000'] : theme['c-primary-font']}
      />
      <Text
        size={designTypography.caption}
        style={[
          styles.text,
          { color: offlineMode ? theme['c-primary-light-1000'] : theme['c-primary-font'] },
        ]}
      >
        {offlineMode ? '离线模式·开' : '离线模式'}
      </Text>
    </TouchableOpacity>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: designSpacing.sm,
    paddingVertical: designSpacing.xs,
    borderRadius: designRadius.pill,
    gap: 4,
  },
  text: {
    fontWeight: '600',
  },
})
