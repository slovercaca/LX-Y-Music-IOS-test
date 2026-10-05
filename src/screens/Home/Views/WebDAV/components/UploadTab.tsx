import { memo } from 'react'
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import CheckBox from '@/components/common/CheckBox'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { getWebDAVMusicDir } from '@/core/webdavMusic/drive'
import TabsHeader from './TabsHeader'
import { formatUploadSize } from '../format'
import type { WebDAVPage } from '../useWebDAVPage'

/**
 * WebDAV「上传」tab（从旧 index.tsx 的 renderUpload 提取，行为不变）。
 *
 * 来源：下载列表（已完成任务）/ 文件 App；冲突预检；分阶段进度；
 * 可选同时上传歌词；完成后重扫当前目录。
 */
export default memo(({ page }: { page: WebDAVPage }) => {
  const theme = useTheme()
  const {
    activeTab, selectTab,
    uploadTargetDir,
    uploadPickerExpanded, setUploadPickerExpanded,
    uploadableTasks, uploadCheckedIds,
    toggleUploadCheck, toggleUploadCheckAll,
    handleAddUploadFromDownloads, handleAddUploadFromFilePicker,
    uploadFiles, handleRemoveUploadFile, handleClearUploadQueue,
    uploadWithLyrics, setUploadWithLyrics,
    uploadProgress, loading, batchLoadingText,
    handleStartUpload,
  } = page

  const totalSize = uploadFiles.reduce((sum, f) => sum + (f.size || 0), 0)

  return (
    <View style={styles.uploadPage}>
      <ScrollView
        style={styles.uploadScroll}
        contentContainerStyle={styles.uploadContent}
        keyboardShouldPersistTaps="handled"
      >
        <TabsHeader activeTab={activeTab} onSelect={selectTab} />
        {/* 上传目标目录 */}
        <View style={styles.uploadSection}>
          <Text size={designTypography.caption} color={theme['c-font-label']}>上传目标目录</Text>
          <Text size={designTypography.body} color={theme['c-font']} numberOfLines={2} style={styles.uploadTargetPath}>
            {getWebDAVMusicDir(uploadTargetDir)}
          </Text>
        </View>

        {/* 来源选择：大按钮（旧按钮 paddingVertical 仅 6，
            触摸目标过小且三按钮宽度不一；新按钮统一 48pt 高、等宽并排） */}
        <View style={styles.uploadSourceRow}>
          <Button
            style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'] }]}
            onPress={() => { setUploadPickerExpanded(v => !v) }}
          >
            <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_downloads')}</Text>
          </Button>
          <Button
            style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'], marginLeft: designSpacing.md }]}
            onPress={handleAddUploadFromFilePicker}
          >
            <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_files')}</Text>
          </Button>
        </View>

        {/* 下载列表（展开时内嵌选择，不再用悬浮窗） */}
        {uploadPickerExpanded ? (
          <View style={styles.uploadSection}>
            <View style={styles.uploadRowHeader}>
              <Text size={designTypography.body} color={theme['c-font']}>{global.i18n.t('webdav_upload_downloaded_files')}</Text>
              <TouchableOpacity onPress={toggleUploadCheckAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text size={designTypography.caption} color={theme['c-primary']}>
                  {uploadCheckedIds.size === uploadableTasks.length && uploadableTasks.length > 0 ? '取消全选' : '全选'}
                </Text>
              </TouchableOpacity>
            </View>
            {uploadableTasks.length === 0 ? (
              <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadEmptyText}>
                没有已完成的下载任务
              </Text>
            ) : (
              uploadableTasks.map(task => {
                const checked = uploadCheckedIds.has(task.id)
                return (
                  <TouchableOpacity
                    key={task.id}
                    style={styles.uploadTaskRow}
                    activeOpacity={0.7}
                    onPress={() => { toggleUploadCheck(task.id) }}
                  >
                    <CheckBox check={checked} onChange={() => { toggleUploadCheck(task.id) }} />
                    <View style={styles.uploadTaskInfo}>
                      <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                        {task.fileName}
                      </Text>
                      <Text size={designTypography.caption} color={theme['c-font-label']}>
                        {formatUploadSize(task.progress?.total)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )
              })
            )}
            <Button
              style={[styles.uploadAddButton, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}
              onPress={handleAddUploadFromDownloads}
            >
              <Text color={theme['c-primary']}>添加所选（{uploadCheckedIds.size}）</Text>
            </Button>
          </View>
        ) : null}

        {/* 待上传队列 */}
        <View style={styles.uploadSection}>
          <View style={styles.uploadQueueHeader}>
            <Text size={designTypography.body} color={theme['c-font']} style={styles.uploadSectionTitle}>
              待上传（{uploadFiles.length}）
            </Text>
            {uploadFiles.length > 0 ? (
              <TouchableOpacity
                onPress={handleClearUploadQueue}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text size={designTypography.caption} color={theme['c-primary']}>{global.i18n.t('webdav_upload_clear')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {/* 上传时是否同时上传歌词 */}
          <TouchableOpacity
            style={styles.uploadLyricsRow}
            activeOpacity={0.7}
            onPress={() => { setUploadWithLyrics(v => !v) }}
          >
            <CheckBox check={uploadWithLyrics} onChange={setUploadWithLyrics} />
            <Text size={designTypography.body} color={theme['c-font']} style={styles.uploadLyricsLabel}>
              同时上传歌词（.lrc）
            </Text>
          </TouchableOpacity>
          <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadLyricsTip}>
            勾选后，上传歌曲时会自动查找同名歌词文件，一并上传到 lrc/ 目录
          </Text>
          {uploadFiles.length === 0 ? (
            <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.uploadEmptyText}>
              还没有添加文件，用上面的按钮选择要上传的音频
            </Text>
          ) : (
            uploadFiles.map(f => (
              <View key={f.localPath} style={styles.uploadFileRow}>
                <View style={styles.uploadTaskInfo}>
                  <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                    {f.fileName}
                  </Text>
                  <Text size={designTypography.caption} color={theme['c-font-label']}>
                    {formatUploadSize(f.size)}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => { handleRemoveUploadFile(f.localPath) }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.uploadRemoveBtn}
                >
                  <Icon name="close" size={16} color={theme['c-font-label']} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* 底部：进度条 + 大上传按钮（固定在内容区底部，不与 tab 栏重叠） */}
      {/* paddingBottom 加大到 100，确保按钮在悬浮 tab 栏上方 */}
      <View style={[styles.uploadFooter, { paddingBottom: 100 }]}>
        {uploadProgress ? (
          <View style={styles.uploadProgressWrap}>
            <View style={styles.uploadProgressHeader}>
              <Text size={designTypography.caption} color={theme['c-font']} numberOfLines={1} style={styles.uploadProgressText}>
                {uploadProgress.fileName
                  ? `正在上传：${uploadProgress.fileName}（${formatUploadSize(uploadProgress.fileSize)}）`
                  : '上传完成'}
              </Text>
              <Text size={designTypography.caption} color={theme['c-font-label']}>
                {uploadProgress.current}/{uploadProgress.total} · {formatUploadSize(uploadProgress.uploadedSize)}/{formatUploadSize(uploadProgress.totalSize)}
              </Text>
            </View>
            <View style={[styles.uploadProgressTrack, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}>
              <View
                style={[
                  styles.uploadProgressBar,
                  {
                    backgroundColor: theme['c-primary'],
                    width: `${uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%`,
                  },
                ]}
              />
            </View>
          </View>
        ) : null}
        <Button
          style={[styles.uploadStartButton, { backgroundColor: theme['c-primary'] }]}
          disabled={uploadFiles.length === 0 || loading || !!batchLoadingText}
          onPress={() => { void handleStartUpload() }}
        >
          <Text color={theme['c-primary-light-1000']}>
            {batchLoadingText || `开始上传${uploadFiles.length > 0 ? `（${uploadFiles.length} 个，${formatUploadSize(totalSize)}）` : ''}`}
          </Text>
        </Button>
      </View>
    </View>
  )
})

const styles = createStyle({
  uploadPage: {
    flex: 1,
  },
  uploadScroll: {
    flex: 1,
  },
  uploadContent: {
    paddingBottom: designSpacing.lg,
  },
  uploadSection: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.md,
  },
  uploadTargetPath: {
    marginTop: designSpacing.xs,
  },
  uploadSourceRow: {
    flexDirection: 'row',
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.sm,
  },
  // 来源按钮：等宽并排、48pt 高，保证触摸目标（旧按钮 paddingVertical 仅 6）
  uploadSourceButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.sm,
  },
  uploadTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
  },
  uploadTaskInfo: {
    flex: 1,
    marginLeft: designSpacing.sm,
  },
  uploadFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  uploadRemoveBtn: {
    padding: designSpacing.sm,
  },
  uploadSectionTitle: {
    marginBottom: designSpacing.sm,
    fontWeight: '600',
  },
  uploadQueueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.sm,
  },
  uploadLyricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
  },
  uploadLyricsLabel: {
    marginLeft: designSpacing.sm,
  },
  uploadLyricsTip: {
    marginBottom: designSpacing.sm,
  },
  uploadEmptyText: {
    paddingVertical: designSpacing.md,
  },
  uploadAddButton: {
    marginTop: designSpacing.md,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadFooter: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.md,
  },
  // 底部上传按钮：全宽、52pt 高，大触摸目标
  uploadStartButton: {
    minHeight: 52,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadProgressWrap: {
    marginBottom: designSpacing.md,
  },
  uploadProgressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: designSpacing.xs,
  },
  uploadProgressText: {
    flex: 1,
    marginRight: designSpacing.sm,
  },
  uploadProgressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  uploadProgressBar: {
    height: 6,
    borderRadius: 3,
  },
})
