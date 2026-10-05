import { memo } from 'react'
import { RefreshControl, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { SvgIcon } from '@/components/common/SvgIcon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import TabsHeader from './TabsHeader'
import { getFolderName } from '../format'
import type { WebDAVPage } from '../useWebDAVPage'

/**
 * WebDAV「目录」tab（从旧 index.tsx 的 renderFolders 提取，行为不变）。
 *
 * 上半：服务器目录浏览，选择「扫描范围」；
 * 下半：已扫描歌曲按目录分组，点一行把歌曲列表筛到该目录。
 */
export default memo(({ page }: { page: WebDAVPage }) => {
  const theme = useTheme()
  const {
    activeTab, selectTab,
    hasConfig, loading, folderLoading,
    folderStack, folders, currentFolder, selectedFolder,
    songs, songFolders,
    goBackFolder, enterFolder, handleSelectCurrentFolder, handleRefreshFolders,
    handleSetFilterPath,
  } = page

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          colors={[theme['c-primary']]}
          refreshing={folderLoading}
          onRefresh={handleRefreshFolders}
        />
      }
    >
      <TabsHeader activeTab={activeTab} onSelect={selectTab} />
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>服务器目录</Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          当前：{getFolderName(currentFolder)}
        </Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          扫描范围：{getFolderName(selectedFolder)}
        </Text>
        <View style={styles.buttonRow}>
          <Button
            style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
            disabled={!hasConfig || folderLoading || !folderStack.length}
            onPress={goBackFolder}
          >
            <Text color={theme['c-button-font']}>返回上级</Text>
          </Button>
          <Button
            style={{ ...styles.button, backgroundColor: theme['c-button-background'] }}
            disabled={!hasConfig || loading}
            onPress={handleSelectCurrentFolder}
          >
            <Text color={theme['c-button-font']}>选择当前目录</Text>
          </Button>
        </View>

        {folderLoading ? (
          <Text style={styles.tip} color={theme['c-font-label']}>
            正在读取目录...
          </Text>
        ) : folders.length ? (
          folders.map(folder => (
            <TouchableOpacity
              key={folder.id}
              style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
              onPress={() => { enterFolder(folder) }}
            >
              <Text numberOfLines={1}>{folder.name}</Text>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                {folder.path}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.tip} color={theme['c-font-label']}>
            {hasConfig ? '当前目录没有子目录。' : '请先在「配置」里填写服务器地址与用户名。'}
          </Text>
        )}
      </View>

      {/* 已扫描歌曲按目录分组：点一行进入该目录浏览（不再跳列表） */}
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>已扫描歌曲的目录</Text>
        <TouchableOpacity
          style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
          onPress={() => {
            handleSetFilterPath(null)
            selectTab('list')
          }}
        >
          <View style={styles.folderItemInfo}>
            <SvgIcon name="music-list" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text>全部歌曲</Text>
            </View>
            <Text size={12} color={theme['c-font-label']}>{songs.length} 首</Text>
          </View>
        </TouchableOpacity>
        {songFolders.length ? (
          songFolders.map(folder => (
            <TouchableOpacity
              key={folder.path}
              style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
              onPress={() => {
                // 进入目录浏览，而非跳列表筛歌
                enterFolder({
                  id: folder.path,
                  name: folder.name,
                  path: folder.path,
                })
              }}
            >
              <View style={styles.folderItemInfo}>
                <SvgIcon name="folder" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1}>{folder.name}</Text>
                  <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                    {folder.path}
                  </Text>
                </View>
                <Text size={12} color={theme['c-font-label']}>{folder.count} 首</Text>
              </View>
            </TouchableOpacity>
          ))
        ) : (
          <View style={styles.empty}>
            <Text color={theme['c-font-label']}>还没有扫描到包含音乐的文件夹</Text>
          </View>
        )}
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
  meta: {
    marginTop: 5,
  },
  tip: {
    marginTop: 6,
    lineHeight: 18,
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
  folderItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  folderItemInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  empty: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
