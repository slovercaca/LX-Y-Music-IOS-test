import { memo } from 'react'
import { Keyboard, ScrollView, StyleSheet, View } from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import InputItem from '@/screens/Home/Views/Setting/components/InputItem'
import WebDAVProfiles from '@/components/common/WebDAVProfiles'
import WebDAVDownloadPath from './WebDAVDownloadPath'
import TabsHeader from './TabsHeader'
import { getFolderName } from '../format'
import type { WebDAVPage } from '../useWebDAVPage'

/**
 * WebDAV「配置」tab（从旧 index.tsx 的 renderConfig 提取，行为不变）。
 *
 * 连接配置与「设置 → 数据同步 → WebDAV 同步」共用 sync.webdav.* 同一批键，
 * 两边改哪边都生效。
 */
export default memo(({ page }: { page: WebDAVPage }) => {
  const theme = useTheme()
  const {
    activeTab, selectTab,
    hasConfig, isTesting,
    webdavUrl, webdavUsername, webdavPassword, webdavMediaSource,
    handleWebdavSettingChanged, handleWebdavMediaSourceChanged, handleTestConnection,
    selectedFolder,
  } = page

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      <TabsHeader activeTab={activeTab} onSelect={selectTab} />
      {/* 服务器配置：一键切换/保存/编辑/删除。下面的手工输入区保留，
          首次配置、临时服务器仍走那里。 */}
      <WebDAVProfiles />
      {/* 连接配置就地可改：与「设置 → 数据同步 → WebDAV 同步」共用同一批设置键
          （sync.webdav.*），不再像旧版那样只给一句「请在设置中配置」把人赶去别的页面。
          注：输入项本身已是卡片（InputItem 自带边框/底色），这里不再套一层 panel，避免双层边框。 */}
      <View style={styles.section}>
        <Text style={styles.label}>连接</Text>
        <Text size={12} color={theme['c-font-label']} style={styles.sectionTip}>
          与「设置 → 数据同步 → WebDAV 同步」是同一份配置，两边改哪边都生效。
        </Text>
      </View>
      <InputItem
        label="服务器地址"
        value={webdavUrl}
        onChanged={handleWebdavSettingChanged('sync.webdav.url')}
        placeholder="https://example.com/webdav"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <InputItem
        label="用户名"
        value={webdavUsername}
        onChanged={handleWebdavSettingChanged('sync.webdav.username')}
        placeholder="请输入用户名"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <InputItem
        label="密码"
        value={webdavPassword}
        onChanged={handleWebdavSettingChanged('sync.webdav.password')}
        placeholder="请输入密码"
        secureTextEntry
      />
      <View style={styles.buttonRow}>
        <Button
          style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
          disabled={!hasConfig || isTesting}
          onPress={() => { void handleTestConnection() }}
        >
          <Text color={theme['c-button-font']}>{isTesting ? '测试中...' : '测试连接'}</Text>
        </Button>
      </View>
      <Text color={hasConfig ? theme['c-primary-font'] : theme['c-font-label']} style={styles.meta}>
        {hasConfig ? '已配置：可直接浏览目录、扫描歌曲' : '未配置：填好服务器地址与用户名后即可使用'}
      </Text>

      <WebDAVDownloadPath />

      {/* 封面歌词来源：歌曲文件 = 同目录同名/通用封面、内嵌标签（默认）；
          云端插件 = 按歌名/歌手在线匹配，失败时回退到歌曲文件 */}
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>封面歌词来源</Text>
        <View style={styles.mediaSourceRow}>
          <Button
            style={{
              ...styles.mediaSourceButton,
              backgroundColor: webdavMediaSource === 'file' ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
            }}
            onPress={() => { handleWebdavMediaSourceChanged('file') }}
          >
            <Text color={webdavMediaSource === 'file' ? theme['c-primary-light-1000'] : theme['c-font']}>
              歌曲文件
            </Text>
          </Button>
          <Button
            style={{
              ...styles.mediaSourceButton,
              marginLeft: designSpacing.sm,
              backgroundColor: webdavMediaSource === 'online' ? theme['c-primary'] : theme['c-primary-light-900-alpha-300'],
            }}
            onPress={() => { handleWebdavMediaSourceChanged('online') }}
          >
            <Text color={webdavMediaSource === 'online' ? theme['c-primary-light-1000'] : theme['c-font']}>
              云端插件
            </Text>
          </Button>
        </View>
        <Text size={12} color={theme['c-font-label']} style={styles.meta}>
          {webdavMediaSource === 'file'
            ? '从歌曲文件获取：同目录同名封面/歌词、音频内嵌标签。'
            : '从云端插件获取：按歌名/歌手在线匹配封面歌词，失败时回退到歌曲文件。'}
          {'\n'}也可在歌曲菜单里手动指定单个歌曲的封面/歌词文件（优先级最高）。
        </Text>
      </View>

      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>扫描范围</Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          {getFolderName(selectedFolder)}
        </Text>
        <Text size={12} color={theme['c-font-label']} style={styles.meta}>
          到「目录」页浏览服务器目录并选择；不选则扫描整个根目录。
        </Text>
      </View>
    </ScrollView>
  )
})

const styles = createStyle({
  scroll: {
    flex: 1,
  },
  content: {
    padding: 12,
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  label: {
    marginBottom: 6,
  },
  section: {
    marginBottom: designSpacing.xs,
  },
  sectionTip: {
    marginTop: 2,
    marginBottom: designSpacing.sm,
  },
  meta: {
    marginTop: 5,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    marginRight: 10,
    marginBottom: 8,
  },
  mediaSourceRow: {
    flexDirection: 'row',
    marginTop: designSpacing.sm,
    marginBottom: designSpacing.sm,
  },
  mediaSourceButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
