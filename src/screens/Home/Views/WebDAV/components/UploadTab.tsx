import { memo, useState } from 'react'
import { ScrollView, StyleSheet, Switch, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import CheckBox from '@/components/common/CheckBox'
import ContentGlass from '@/components/common/ContentGlass'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { getWebDAVMusicDir } from '@/core/webdavMusic/drive'
import TabsHeader from './TabsHeader'
import { formatUploadSize, formatSpeed, formatEta, formatBriefTime } from '../format'
import type { WebDAVUploadQueueItem, WebDAVUploadStatus } from '@/core/webdavMusic/upload'
import type { useUploadManager } from '../useUploadManager'
import { UPLOAD_PHASE_TEXT } from '../useUploadManager'
import type { ActiveTab } from '../useWebDAVPage'

export interface UploadTabProps {
  activeTab: ActiveTab
  selectTab: (tab: ActiveTab) => void
  uploadTargetDir: string
  uploadWithLyrics: boolean
  setUploadWithLyrics: (v: boolean | ((p: boolean) => boolean)) => void
  uploadManager: ReturnType<typeof useUploadManager>
}

const statusText: Record<WebDAVUploadStatus, string> = {
  queued: '等待上传',
  uploading: '上传中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 单项状态行：有字节进度时显示 已上传/总大小 · 速度 · 剩余时间；
 * 无字节进度（webdav 库传输）时显示"正在上传到服务器…"，避免 0 B 假卡死观感 */
const ItemStatusLine = ({ item }: { item: WebDAVUploadQueueItem }) => {
  const theme = useTheme()
  let text = statusText[item.status]
  if (item.status === 'uploading') {
    // 阶段优先：卡顿/准备中/等待服务器时显示阶段文案，避免误导
    const phase = (item as any).phase as string | undefined
    const phaseDetail = (item as any).phaseDetail as string | undefined
    if (phase === 'stalled') {
      text = `网络卡顿…${phaseDetail ? `（${phaseDetail}）` : ''}`
    } else if (phase === 'preparing') {
      text = '准备中…'
    } else if (phase === 'waiting') {
      text = '等待服务器响应…'
    } else if (item.uploadedBytes > 0 && item.size > 0) {
      const sizeText = `${formatUploadSize(item.uploadedBytes)} / ${formatUploadSize(item.size)}`
      const speedText = formatSpeed(item.speed)
      const etaText = item.speed > 0
        ? formatEta((item.size - item.uploadedBytes) / item.speed)
        : ''
      text = [sizeText, speedText, etaText].filter(Boolean).join(' · ')
    } else {
      text = `正在上传到服务器…（${formatUploadSize(item.size)}）`
    }
    if (!text) text = '正在连接…'
  } else if (item.status === 'failed' && item.error) {
    text = `失败：${item.error}`
  } else if (item.status === 'completed') {
    text = `已完成 · ${formatUploadSize(item.size)}`
  }
  return (
    <Text
      size={designTypography.caption}
      color={item.status === 'failed' ? '#ff3b30' : theme['c-font-label']}
      numberOfLines={2}
    >
      {text}
    </Text>
  )
}

/**
 * WebDAV「上传」tab（2026-10-05 重写）：上传管理器界面。
 * - 上传队列：增删、暂停/继续（单项与全部）、失败重试、多选批量删除
 * - 真实进度：每项显示已上传/总大小、速度、剩余时间；队列汇总
 * - 并发：并行线程数可调（设置 webdav.uploadConcurrency，1-6）
 * - 历史：完成/失败记录持久化，可查看、可清空
 * - 内容区玻璃（theme.glassContent）：各卡片走 ContentGlass
 * - 操作按钮全部在内容流内，不再用底部悬浮按钮（修复被底栏进度条遮挡）
 */
export default memo(({ page }: { page: UploadTabProps }) => {
  const theme = useTheme()
  const { activeTab, selectTab, uploadTargetDir, uploadWithLyrics, setUploadWithLyrics } = page
  const mgr = page.uploadManager
  const { items, stats, queueState, history, selectedIds, concurrency } = mgr
  // 分块/断点续传开关
  const resumeEnabled = useSettingValue('webdav.uploadResume')
  const chunkedEnabled = useSettingValue('webdav.uploadChunked')
  const chunkSizeMB = useSettingValue('webdav.uploadChunkSizeMB')

  const [pickerExpanded, setPickerExpanded] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [multiSelect, setMultiSelect] = useState(false)

  const pendingCount = stats.queued + stats.paused + stats.failed
  const hasActive = stats.uploading > 0 || stats.queued > 0

  const toggleCheck = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleCheckAll = () => {
    if (checkedIds.size === mgr.uploadableTasks.length && mgr.uploadableTasks.length > 0) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(mgr.uploadableTasks.map(t => t.id)))
    }
  }

  const overallPercent = stats.totalBytes > 0
    ? Math.min(100, (stats.uploadedBytes / stats.totalBytes) * 100)
    : 0

  return (
    <View style={styles.uploadPage}>
      <ScrollView
        style={styles.uploadScroll}
        contentContainerStyle={styles.uploadContent}
        keyboardShouldPersistTaps="handled"
      >
        <TabsHeader activeTab={activeTab} onSelect={selectTab} />

        {/* 上传目标目录 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <Text size={designTypography.caption} color={theme['c-font-label']}>上传目标目录</Text>
          <Text size={designTypography.body} color={theme['c-font']} numberOfLines={2} style={styles.targetPath}>
            {getWebDAVMusicDir(uploadTargetDir)}
          </Text>
          <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
            音频进 music/，歌词进同级的 lrc/
          </Text>
        </ContentGlass>

        {/* 并发设置 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.rowBetween}>
            <View style={styles.flex1}>
              <Text size={designTypography.body} color={theme['c-font']}>并行上传数</Text>
              <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
                同时上传的线程数（1-6）
              </Text>
            </View>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={[styles.stepBtn, { borderColor: theme['c-border-background'] }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => { mgr.setConcurrency(concurrency - 1) }}
                disabled={queueState === 'uploading'}
              >
                <Text size={designTypography.title2} color={theme['c-font']}>−</Text>
              </TouchableOpacity>
              <Text size={designTypography.title2} color={theme['c-font']} style={styles.stepValue}>
                {concurrency}
              </Text>
              <TouchableOpacity
                style={[styles.stepBtn, { borderColor: theme['c-border-background'] }]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => { mgr.setConcurrency(concurrency + 1) }}
                disabled={queueState === 'uploading'}
              >
                <Text size={designTypography.title2} color={theme['c-font']}>＋</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ContentGlass>

        {/* 断点续传开关 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.rowBetween}>
            <View style={styles.flex1}>
              <Text size={designTypography.body} color={theme['c-font']}>断点续传</Text>
              <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
                上传中断后从断点继续，不用从头传
              </Text>
            </View>
            <Switch
              value={resumeEnabled !== false}
              onValueChange={(v) => { void updateSetting({ 'webdav.uploadResume': v }) }}
              disabled={queueState === 'uploading'}
            />
          </View>
        </ContentGlass>

        {/* 分块上传开关 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.rowBetween}>
            <View style={styles.flex1}>
              <Text size={designTypography.body} color={theme['c-font']}>分块上传</Text>
              <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
                大文件切块逐块传，单块失败只重传该块（块串行，文件并行）
              </Text>
            </View>
            <Switch
              value={chunkedEnabled === true}
              onValueChange={(v) => { void updateSetting({ 'webdav.uploadChunked': v }) }}
              disabled={queueState === 'uploading'}
            />
          </View>
          {chunkedEnabled === true ? (
            <View style={[styles.rowBetween, { marginTop: 8 }]}>
              <Text size={designTypography.caption} color={theme['c-font-label']}>分块大小</Text>
              <View style={styles.stepper}>
                <TouchableOpacity
                  style={[styles.stepBtn, { borderColor: theme['c-border-background'] }]}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => { void updateSetting({ 'webdav.uploadChunkSizeMB': Math.max(1, (Number(chunkSizeMB) || 5) - 1) }) }}
                  disabled={queueState === 'uploading'}
                >
                  <Text size={designTypography.title2} color={theme['c-font']}>−</Text>
                </TouchableOpacity>
                <Text size={designTypography.title2} color={theme['c-font']} style={styles.stepValue}>
                  {Number(chunkSizeMB) || 5}MB
                </Text>
                <TouchableOpacity
                  style={[styles.stepBtn, { borderColor: theme['c-border-background'] }]}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => { void updateSetting({ 'webdav.uploadChunkSizeMB': Math.min(100, (Number(chunkSizeMB) || 5) + 1) }) }}
                  disabled={queueState === 'uploading'}
                >
                  <Text size={designTypography.title2} color={theme['c-font']}>＋</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </ContentGlass>

        {/* 来源选择 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.uploadSourceRow}>
            <Button
              style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'] }]}
              onPress={() => { setPickerExpanded(v => !v) }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_downloads')}</Text>
            </Button>
            <Button
              style={[styles.uploadSourceButton, { backgroundColor: theme['c-button-background'], marginLeft: designSpacing.md }]}
              onPress={mgr.addFromFilePicker}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('webdav_upload_from_files')}</Text>
            </Button>
          </View>
          <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
            文件 App 可重复点选，多次添加；歌词（.lrc）可一并加入
          </Text>

          {pickerExpanded ? (
            <View style={styles.taskList}>
              <View style={styles.rowBetween}>
                <Text size={designTypography.body} color={theme['c-font']}>
                  {global.i18n.t('webdav_upload_downloaded_files')}
                </Text>
                <TouchableOpacity onPress={toggleCheckAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text size={designTypography.caption} color={theme['c-primary']}>
                    {checkedIds.size === mgr.uploadableTasks.length && mgr.uploadableTasks.length > 0 ? '取消全选' : '全选'}
                  </Text>
                </TouchableOpacity>
              </View>
              {mgr.uploadableTasks.length === 0 ? (
                <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.emptyText}>
                  没有已完成的下载任务
                </Text>
              ) : (
                mgr.uploadableTasks.map(task => {
                  const checked = checkedIds.has(task.id)
                  return (
                    <TouchableOpacity
                      key={task.id}
                      style={styles.taskRow}
                      activeOpacity={0.7}
                      onPress={() => { toggleCheck(task.id) }}
                    >
                      <CheckBox check={checked} onChange={() => { toggleCheck(task.id) }} />
                      <View style={styles.taskInfo}>
                        <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                          {task.fileName}
                        </Text>
                        <Text size={designTypography.caption} color={theme['c-font-label']}>
                          {formatUploadSize((task as any).progress?.total)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )
                })
              )}
              <Button
                style={[styles.addButton, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}
                onPress={() => {
                  mgr.addFromTasks(checkedIds)
                  setCheckedIds(new Set())
                  setPickerExpanded(false)
                }}
              >
                <Text color={theme['c-primary']}>添加所选（{checkedIds.size}）</Text>
              </Button>
            </View>
          ) : null}
        </ContentGlass>

        {/* 队列控制 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.rowBetween}>
            <Text size={designTypography.body} color={theme['c-font']} style={styles.sectionTitle}>
              上传队列（{stats.total}）
            </Text>
            <View style={styles.row}>
              <TouchableOpacity
                onPress={() => { setMultiSelect(v => !v) }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.linkBtn}
              >
                <Text size={designTypography.caption} color={multiSelect ? '#ff3b30' : theme['c-primary']}>
                  {multiSelect ? '取消多选' : '多选'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={mgr.clearFinished}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.linkBtn}
              >
                <Text size={designTypography.caption} color={theme['c-primary']}>清理已完成</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* 队列总进度 */}
          {stats.total > 0 ? (
            <View style={styles.queueProgress}>
              <View style={styles.rowBetween}>
                <Text size={designTypography.caption} color={theme['c-font-label']} numberOfLines={1} style={styles.flex1}>
                  {queueState === 'uploading'
                    ? `上传中 ${stats.uploading} · 等待 ${stats.queued}`
                    : queueState === 'paused'
                      ? `已暂停 · 等待 ${stats.queued + stats.paused}`
                      : `等待 ${pendingCount} · 完成 ${stats.completed} · 失败 ${stats.failed}`}
                </Text>
                <Text size={designTypography.caption} color={theme['c-font-label']}>
                  {formatUploadSize(stats.uploadedBytes)}/{formatUploadSize(stats.totalBytes)}
                </Text>
              </View>
              <View style={[styles.track, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}>
                <View
                  style={[
                    styles.bar,
                    { backgroundColor: theme['c-primary'], width: `${overallPercent}%` },
                  ]}
                />
              </View>
            </View>
          ) : null}

          {/* 开始/暂停/继续（内容流内按钮，不再悬浮底部） */}
          <View style={styles.controlRow}>
            {queueState === 'uploading' ? (
              <Button
                style={[styles.controlBtn, { backgroundColor: theme['c-button-background'] }]}
                onPress={mgr.pause}
              >
                <Text color={theme['c-button-font']}>暂停全部</Text>
              </Button>
            ) : (
              <Button
                style={[styles.controlBtn, { backgroundColor: theme['c-primary'] }]}
                onPress={() => { void (queueState === 'paused' ? mgr.resume() : mgr.start()) }}
                disabled={pendingCount === 0}
              >
                <Text color={theme['c-primary-light-1000']}>
                  {queueState === 'paused' ? '继续上传' : `开始上传${pendingCount > 0 ? `（${pendingCount}）` : ''}`}
                </Text>
              </Button>
            )}
            <Button
              style={[styles.controlBtn, { backgroundColor: theme['c-button-background'], marginLeft: designSpacing.md }]}
              onPress={mgr.clearAll}
              disabled={stats.total === 0 || hasActive}
            >
              <Text color={theme['c-button-font']}>清空队列</Text>
            </Button>
          </View>
          {multiSelect && selectedIds.size > 0 ? (
            <Button
              style={[styles.deleteSelectedBtn, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}
              onPress={mgr.deleteSelected}
            >
              <Text color="#ff3b30">删除所选（{selectedIds.size}）</Text>
            </Button>
          ) : null}
          {multiSelect ? (
            <TouchableOpacity onPress={mgr.toggleSelectAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.selectAllRow}>
              <Text size={designTypography.caption} color={theme['c-primary']}>
                {selectedIds.size === items.length && items.length > 0 ? '取消全选' : '全选'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {/* 歌词选项 */}
          <TouchableOpacity
            style={styles.lyricsRow}
            activeOpacity={0.7}
            onPress={() => { setUploadWithLyrics(v => !v) }}
          >
            <CheckBox check={uploadWithLyrics} onChange={setUploadWithLyrics} />
            <Text size={designTypography.body} color={theme['c-font']} style={styles.lyricsLabel}>
              同时上传歌词（.lrc）
            </Text>
          </TouchableOpacity>
          <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.tip}>
            勾选后，音频入队时自动查找同名歌词，一并上传到 lrc/ 目录
          </Text>

          {/* 队列项 */}
          {items.length === 0 ? (
            <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.emptyText}>
              队列为空，用上面的按钮添加要上传的音频
            </Text>
          ) : (
            items.map(item => (
              <View key={item.id} style={styles.itemRow}>
                {multiSelect ? (
                  <CheckBox
                    check={selectedIds.has(item.id)}
                    onChange={() => { mgr.toggleSelect(item.id) }}
                  />
                ) : null}
                <View style={styles.itemMain}>
                  <View style={styles.itemTitleRow}>
                    <View
                      style={[
                        styles.kindBadge,
                        { backgroundColor: item.kind === 'lrc'
                          ? theme['c-primary-light-900-alpha-300']
                          : theme['c-button-background'] },
                      ]}
                    >
                      <Text
                        size={designTypography.caption}
                        color={item.kind === 'lrc' ? theme['c-primary'] : theme['c-font-label']}
                      >
                        {item.kind === 'lrc' ? '歌词' : '音频'}
                      </Text>
                    </View>
                    <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1} style={styles.flex1}>
                      {item.fileName}
                    </Text>
                  </View>
                  <Text size={designTypography.caption} color={theme['c-font-label']} numberOfLines={1}>
                    → {item.remotePath}
                  </Text>
                  {item.uploadedBytes > 0 && item.status !== 'completed' ? (
                    <View style={[styles.track, styles.itemTrack, { backgroundColor: theme['c-primary-light-900-alpha-300'] }]}>
                      <View
                        style={[
                          styles.bar,
                          {
                            backgroundColor: theme['c-primary'],
                            width: `${item.size > 0 ? Math.min(100, (item.uploadedBytes / item.size) * 100) : 0}%`,
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                  <ItemStatusLine item={item} />
                  <View style={styles.itemActions}>
                    {item.status === 'uploading' ? (
                      <TouchableOpacity onPress={() => { mgr.pauseItem(item.id) }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.actionBtn}>
                        <Text size={designTypography.caption} color={theme['c-primary']}>暂停</Text>
                      </TouchableOpacity>
                    ) : null}
                    {item.status === 'paused' ? (
                      <TouchableOpacity onPress={() => { mgr.retryItem(item.id) }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.actionBtn}>
                        <Text size={designTypography.caption} color={theme['c-primary']}>继续</Text>
                      </TouchableOpacity>
                    ) : null}
                    {item.status === 'failed' || item.status === 'cancelled' ? (
                      <TouchableOpacity onPress={() => { mgr.retryItem(item.id) }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.actionBtn}>
                        <Text size={designTypography.caption} color={theme['c-primary']}>重试</Text>
                      </TouchableOpacity>
                    ) : null}
                    {item.status !== 'uploading' ? (
                      <TouchableOpacity onPress={() => { mgr.removeItem(item.id) }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.actionBtn}>
                        <Icon name="close" size={14} color={theme['c-font-label']} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </View>
            ))
          )}
        </ContentGlass>

        {/* 上传历史 */}
        <ContentGlass
          style={styles.card}
          glassStyle={styles.cardGlass}
          fallbackBackgroundColor={theme['c-content-background']}
        >
          <View style={styles.rowBetween}>
            <Text size={designTypography.body} color={theme['c-font']} style={styles.sectionTitle}>
              上传历史（{history.length}）
            </Text>
            {history.length > 0 ? (
              <TouchableOpacity onPress={mgr.clearHistory} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text size={designTypography.caption} color={theme['c-primary']}>清空历史</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {history.length === 0 ? (
            <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.emptyText}>
              暂无上传记录
            </Text>
          ) : (
            history.slice(0, 20).map(h => (
              <View key={h.id} style={styles.historyRow}>
                <View style={styles.flex1}>
                  <Text size={designTypography.body} color={theme['c-font']} numberOfLines={1}>
                    {h.fileName}
                  </Text>
                  <Text size={designTypography.caption} color={theme['c-font-label']} numberOfLines={1}>
                    {formatBriefTime(h.finishedAt)} · {formatUploadSize(h.size)}
                    {h.status === 'failed' && h.error ? ` · ${h.error}` : ''}
                  </Text>
                </View>
                <Text
                  size={designTypography.caption}
                  color={h.status === 'completed' ? theme['c-primary'] : '#ff3b30'}
                >
                  {h.status === 'completed' ? '成功' : '失败'}
                </Text>
              </View>
            ))
          )}
          {history.length > 20 ? (
            <Text size={designTypography.caption} color={theme['c-font-label']} style={styles.emptyText}>
              仅显示最近 20 条
            </Text>
          ) : null}
        </ContentGlass>
      </ScrollView>
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
    paddingBottom: designSpacing.xl,
  },
  card: {
    marginHorizontal: designSpacing.lg,
    marginTop: designSpacing.md,
    padding: designSpacing.md,
    borderRadius: designRadius.lg,
  },
  cardGlass: {
    borderRadius: designRadius.lg,
  },
  flex1: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontWeight: '600',
  },
  targetPath: {
    marginTop: designSpacing.xs,
  },
  tip: {
    marginTop: designSpacing.xs,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: designRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    minWidth: 40,
    textAlign: 'center',
    fontWeight: '600',
  },
  uploadSourceRow: {
    flexDirection: 'row',
    paddingVertical: designSpacing.sm,
  },
  uploadSourceButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskList: {
    marginTop: designSpacing.sm,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
  },
  taskInfo: {
    flex: 1,
    marginLeft: designSpacing.sm,
  },
  addButton: {
    marginTop: designSpacing.md,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    paddingVertical: designSpacing.md,
  },
  linkBtn: {
    marginLeft: designSpacing.md,
  },
  queueProgress: {
    marginTop: designSpacing.sm,
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: designSpacing.xs,
  },
  bar: {
    height: 6,
    borderRadius: 3,
  },
  controlRow: {
    flexDirection: 'row',
    marginTop: designSpacing.md,
  },
  controlBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteSelectedBtn: {
    marginTop: designSpacing.md,
    minHeight: 44,
    borderRadius: designRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectAllRow: {
    marginTop: designSpacing.sm,
    alignItems: 'flex-end',
  },
  lyricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
    marginTop: designSpacing.sm,
  },
  lyricsLabel: {
    marginLeft: designSpacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: designSpacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: designSpacing.xs,
  },
  itemMain: {
    flex: 1,
    marginLeft: designSpacing.sm,
  },
  itemTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kindBadge: {
    paddingHorizontal: designSpacing.xs,
    paddingVertical: 2,
    borderRadius: designRadius.sm,
    marginRight: designSpacing.xs,
  },
  itemTrack: {
    marginVertical: designSpacing.xs,
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: designSpacing.xs,
  },
  actionBtn: {
    marginRight: designSpacing.lg,
    paddingVertical: 4,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: designSpacing.xs,
  },
})
