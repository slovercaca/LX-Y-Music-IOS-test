import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { SectionList, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useDownloadTasks } from '@/store/download/hook'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import { pauseTask, removeTask } from '@/core/download'
import { existsFile } from '@/utils/fs'
import ListItem from '@/screens/DownloadManager/ListItem'
import DownloadPathBar from '@/screens/DownloadManager/DownloadPathBar'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

import DownloadTask = LX.Download.DownloadTask

interface DownloadSection {
  key: 'active' | 'completed'
  title: string
  data: DownloadTask[]
}

/**
 * 「本地与下载」页内的下载标签（2026-11-12）：取代独立下载管理页。
 *
 * 分组照酷狗布局：上方「下载中」放所有未完成任务（等待/下载/暂停/失败），
 * 带全部暂停与全部清空；下方「已完成」放全部已完成下载记录。已完成记录
 * 即使对应文件已被外部删除/移动也保留在这里管理——本地标签只认磁盘扫描，
 * 记录则以这里为准，两边职责不再混在一起产生幻影条目。已完成组头有
 * 「清理记录」：一键删掉文件已不存在的失效记录（只删记录、不动文件），
 * 避免用户在文件 App 里删过歌之后记录越积越多。
 */
export default memo(({ bottomInset }: { bottomInset: number }) => {
  const theme = useTheme()
  const tasks = useDownloadTasks()

  const activeTasks = useMemo(
    () => tasks.filter(task => task.status !== 'completed'),
    [tasks],
  )
  const completedTasks = useMemo(
    () => tasks.filter(task => task.status === 'completed'),
    [tasks],
  )

  // 已完成记录对应的文件是否还在：不在的要在行里如实标注「文件不存在」，
  // 不能继续显示成一首可播放的已完成歌曲。
  const completedKey = useMemo(
    () => completedTasks.map(task => `${task.id}:${task.filePath}`).join('|'),
    [completedTasks],
  )
  const [missingIds, setMissingIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let active = true
    if (completedTasks.length === 0) {
      setMissingIds(new Set())
      return
    }
    void Promise.all(
      completedTasks.map(async task => ({
        id: task.id,
        exists: task.filePath ? await existsFile(task.filePath).catch(() => false) : false,
      })),
    ).then(rows => {
      if (!active) return
      setMissingIds(new Set(rows.filter(row => !row.exists).map(row => row.id)))
    })
    return () => { active = false }
    // completedKey 已包含 id+filePath，足以代表 completedTasks 的变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedKey])

  const sections = useMemo<DownloadSection[]>(() => {
    const list: DownloadSection[] = []
    if (activeTasks.length > 0) list.push({ key: 'active', title: '下载中', data: activeTasks })
    if (completedTasks.length > 0) list.push({ key: 'completed', title: '已完成', data: completedTasks })
    return list
  }, [activeTasks, completedTasks])

  // 点 X 先说清后果（原独立页 D3 语义保留）：已完成只删记录留文件、
  // 下载中会删未完成文件，两者差别很大
  const handleRemove = useCallback((id: string) => {
    const task = tasks.find(t => t.id === id)
    if (!task) return
    const message = task.status === 'completed'
      ? missingIds.has(id)
        ? '只删除这条下载记录；它对应的文件已经不存在。'
        : '只删除这条下载记录，已下载的文件会保留，可在「本地」标签中播放。'
      : task.status === 'downloading' || task.status === 'waiting'
        ? '将取消该任务并删除未完成的文件，确定吗？'
        : '将删除这条下载任务，确定吗？'
    void confirmDialog({
      title: '删除下载任务',
      message,
      cancelButtonText: '取消',
      confirmButtonText: '删除',
      destructive: true,
    }).then((confirm) => {
      if (confirm) removeTask(id)
    })
  }, [tasks, missingIds])

  const pausableCount = activeTasks.filter(task => task.status === 'waiting' || task.status === 'downloading').length

  const handlePauseAll = useCallback(() => {
    const targets = activeTasks.filter(task => task.status === 'waiting' || task.status === 'downloading')
    if (targets.length === 0) return
    for (const task of targets) pauseTask(task.id)
    toast('已暂停全部下载', 'short')
  }, [activeTasks])

  // 全部清空只清未完成任务：已完成记录是用户的下载历史，不跟着一起没
  const handleClearActive = useCallback(() => {
    if (activeTasks.length === 0) return
    void confirmDialog({
      title: '清空下载中',
      message: `将取消 ${activeTasks.length} 个未完成任务，并删除它们的未完成文件。已完成记录不受影响，确定吗？`,
      cancelButtonText: '取消',
      confirmButtonText: '全部清空',
      destructive: true,
    }).then((confirm) => {
      if (!confirm) return
      for (const task of [...activeTasks]) removeTask(task.id)
      toast('已清空未完成任务', 'short')
    })
  }, [activeTasks])

  // 失效记录 = 已完成但文件已不在磁盘上的记录。这类记录留着只会越积越多，
  // 「清理记录」把它们一次删净；文件还在的记录与音乐文件本身都不受影响。
  const staleRecordCount = useMemo(
    () => completedTasks.filter(task => missingIds.has(task.id)).length,
    [completedTasks, missingIds],
  )

  const handleCleanRecords = useCallback(() => {
    if (staleRecordCount === 0) {
      toast('没有需要清理的下载记录', 'short')
      return
    }
    void confirmDialog({
      title: '清理下载记录',
      message: `将删除 ${staleRecordCount} 条文件已不存在的下载记录。已下载的音乐文件不受影响，确定吗？`,
      cancelButtonText: '取消',
      confirmButtonText: '清理',
      destructive: true,
    }).then((confirm) => {
      if (!confirm) return
      for (const task of completedTasks) {
        if (missingIds.has(task.id)) removeTask(task.id)
      }
      toast(`已清理 ${staleRecordCount} 条失效记录`, 'short')
    })
  }, [staleRecordCount, completedTasks, missingIds])

  const renderItem = useCallback(({ item }: { item: DownloadTask }) => (
    <ListItem
      task={item}
      onRemove={handleRemove}
      fileMissing={item.status === 'completed' && missingIds.has(item.id)}
    />
  ), [handleRemove, missingIds])

  const renderSectionHeader = useCallback(({ section }: { section: DownloadSection }) => (
    <View style={styles.sectionHeader}>
      <Text size={designTypography.body} color={theme['c-font']} style={styles.sectionTitle}>
        {section.title} {section.data.length}
      </Text>
      {section.key === 'active' ? (
        <View style={styles.sectionActions}>
          <TouchableOpacity
            style={{ ...styles.sectionActionBtn, backgroundColor: theme['c-primary-background'], opacity: pausableCount > 0 ? 1 : 0.5 }}
            onPress={handlePauseAll}
            disabled={pausableCount === 0}
          >
            <Text size={designTypography.caption} color={theme['c-primary-font']}>全部暂停</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ ...styles.sectionActionBtn, backgroundColor: theme['c-primary-background'] }}
            onPress={handleClearActive}
          >
            <Text size={designTypography.caption} color="#e5484d">全部清空</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={{ ...styles.sectionActionBtn, backgroundColor: theme['c-primary-background'], opacity: staleRecordCount > 0 ? 1 : 0.5 }}
          onPress={handleCleanRecords}
        >
          <Text size={designTypography.caption} color={theme['c-primary-font']}>
            清理记录{staleRecordCount > 0 ? ` (${staleRecordCount})` : ''}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  ), [theme, pausableCount, handlePauseAll, handleClearActive, staleRecordCount, handleCleanRecords])

  return (
    <SectionList
      style={styles.container}
      sections={sections}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<DownloadPathBar />}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      ListEmptyComponent={(
        <View style={styles.emptyWrap}>
          <Text size={14} color={theme['c-font-label']}>暂无下载任务</Text>
        </View>
      )}
    />
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: designSpacing.md,
    paddingTop: designSpacing.lg,
    paddingBottom: designSpacing.xs,
  },
  sectionTitle: {
    fontWeight: '600',
  },
  sectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: designSpacing.sm,
  },
  sectionActionBtn: {
    height: 30,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingTop: 60,
  },
})
