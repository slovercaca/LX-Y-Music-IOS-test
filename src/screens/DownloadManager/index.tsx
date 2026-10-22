import { memo, useCallback, useEffect, useMemo } from 'react'
import { View, FlatList } from 'react-native'
import PageContent from '@/components/PageContent'
import Header from './Header'
import ListItem from './ListItem'
import DownloadPathBar from './DownloadPathBar'
import { useDownloadTasks } from '@/store/download/hook'
import { confirmDialog, createStyle, getRowInfo } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { setComponentId } from '@/core/common'
import { removeTask } from '@/core/download'
import { COMPONENT_IDS } from '@/config/constant'
import LandscapeCentered from '@/components/LandscapeCentered'
import { useHorizontalMode } from '@/utils/hooks'

export default memo(({ componentId }: { componentId: string }) => {
  useEffect(() => {
    setComponentId(COMPONENT_IDS.DOWNLOAD_MANAGER, componentId)
  }, [componentId])

  const tasks = useDownloadTasks()

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免下载卡片在超宽屏
  // 上被拉成一行很长、左右大片留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  const rowInfo = useMemo(() => {
    void isHorizontal
    return getRowInfo()
  }, [isHorizontal])
  const numColumns = rowInfo.rowNum ?? 1

  const theme = useTheme()
  // 点 X 先说清后果（D3）：已完成只删记录留文件、下载中会删未完成文件，两者差别很大
  const handleRemove = useCallback((id: string) => {
    const task = tasks.find(t => t.id === id)
    if (!task) return
    const message = task.status === 'completed'
      ? '只删除这条下载记录，已下载的文件会保留，可在「本地与下载」中播放。'
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
  }, [tasks])

  const renderItem = useCallback(({ item }: { item: LX.Download.DownloadTask }) => (
    <ListItem
      task={item}
      rowWidth={rowInfo.rowWidth}
      onRemove={handleRemove}
    />
  ), [handleRemove, rowInfo.rowWidth])

  return (
    <PageContent>
      <LandscapeCentered>
        <View style={styles.container}>
          <Header componentId={componentId} />
          <DownloadPathBar />
          <FlatList
            key={`cols-${numColumns}`}
            data={tasks}
            contentContainerStyle={{ paddingBottom: 80 }}
            numColumns={numColumns}
            renderItem={renderItem}
            keyExtractor={item => item.id}
            ListEmptyComponent={(
              <View style={styles.emptyWrap}>
                <Text size={14} color={theme['c-font-label']}>暂无下载任务</Text>
              </View>
            )}
          />
        </View>
      </LandscapeCentered>
    </PageContent>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingTop: 60,
  },
})
