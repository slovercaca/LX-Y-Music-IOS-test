import { memo, useState, useEffect, useRef, useMemo } from 'react'
import { View, TouchableOpacity, Animated, Easing } from 'react-native'
import Text from '@/components/common/Text'
import * as Progress from 'react-native-progress'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useSafeAreaBottom } from '@/store/common/hook'
import { createStyle, clamp01 } from '@/utils/tools'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import downloadState from '@/store/download/state'

import DownloadTask = LX.Download.DownloadTask

export default memo(() => {
  const theme = useTheme()
  const safeAreaBottom = useSafeAreaBottom()
  const [isVisible, setIsVisible] = useState(false)
  const [activeTasks, setActiveTasks] = useState<Map<string, DownloadTask>>(new Map())
  const scaleAnim = useRef(new Animated.Value(0)).current

  const { totalProgress, isCompleted, hasError, pendingCount } = useMemo(() => {
    if (activeTasks.size === 0) return { totalProgress: 0, isCompleted: true, hasError: false, pendingCount: 0 }

    const taskList = Array.from(activeTasks.values())
    const hasError = taskList.some(t => t.status === 'error')
    const pendingCount = taskList.filter(t => t.status === 'downloading' || t.status === 'waiting').length
    const allFinished = taskList.every(t => t.status === 'completed' || t.status === 'error' || t.status === 'paused')
    // 全部结束时直接画满圈：失败任务的 percent 可能停在 30%~40%，
    // 若继续取平均值会出现「勾已完成、圆环却只画了一小截」的矛盾状态。
    if (allFinished) return { totalProgress: 1, isCompleted: true, hasError, pendingCount }

    let currentProgress = 0
    for (const task of taskList) {
      currentProgress += task.progress.percent
    }
    // 收敛到 [0,1]：原生下载回调的 percent 可能越界，react-native-progress
    // 的插值不接受越界输入，会导致圆环画过头。
    const totalProgress = clamp01(currentProgress / activeTasks.size)

    return { totalProgress, isCompleted: allFinished, hasError, pendingCount }
  }, [activeTasks])

  // 状态色：有失败用警示红（D7——此前失败也显示绿色对勾，像全部成功）；
  // 全部成功才用成功绿
  const successColor = (theme as unknown as Record<string, string>)['c-success']
  const settledColor = hasError ? '#e5484d' : successColor

  useEffect(() => {
    const handleTaskAdd = (task: LX.Download.DownloadTask) => {
      if (!isVisible) {
        setIsVisible(true)
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true }).start()
      }
      setActiveTasks(prev => new Map(prev).set(task.id, task))
    }

    const handleProgressUpdate = ({ id, progress }: { id: string, progress: LX.Download.DownloadTask['progress'] }) => {
      setActiveTasks(prev => {
        if (!prev.has(id)) return prev
        const newTasks = new Map(prev)
        const task = newTasks.get(id)!
        newTasks.set(id, { ...task, progress })
        return newTasks
      })
    }

    const handleStatusUpdate = ({ id, status }: { id: string, status: LX.Download.DownloadTask['status'] }) => {
      setActiveTasks(prev => {
        if (!prev.has(id)) return prev
        const newTasks = new Map(prev)
        const task = newTasks.get(id)!
        newTasks.set(id, { ...task, status })
        return newTasks
      })
    }

    // 中-19：任务被删时没有任何事件通知悬浮球，删掉等待中任务后球里会残留
    // 僵尸条目（pendingCount 恒 ≥1、永不自动收起）。用 list_changed 对账：
    // 只保留仍在下载状态表里的任务。
    const handleListChanged = () => {
      const alive = new Set(downloadState.tasks.map(t => t.id))
      setActiveTasks(prev => {
        let changed = false
        const next = new Map<string, DownloadTask>()
        for (const [id, task] of prev) {
          if (alive.has(id)) next.set(id, task)
          else changed = true
        }
        return changed ? next : prev
      })
    }

    global.app_event.on('download_task_add', handleTaskAdd)
    global.app_event.on('download_progress_update', handleProgressUpdate)
    global.app_event.on('download_status_update', handleStatusUpdate)
    global.app_event.on('download_list_changed', handleListChanged)

    return () => {
      global.app_event.off('download_task_add', handleTaskAdd)
      global.app_event.off('download_progress_update', handleProgressUpdate)
      global.app_event.off('download_status_update', handleStatusUpdate)
      global.app_event.off('download_list_changed', handleListChanged)
    }
  }, [isVisible, scaleAnim])

  useEffect(() => {
    if (isVisible && isCompleted && !hasError && activeTasks.size > 0) {
      Animated.sequence([
        Animated.timing(scaleAnim, { toValue: 1.2, duration: 200, useNativeDriver: true }),
        Animated.timing(scaleAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start()
    }
  }, [isCompleted, hasError, isVisible, activeTasks.size, scaleAnim])

  // 全部结算后停留 4 秒自动收起（D16）：此前要么点一下才消失、要么永久悬浮遮挡
  useEffect(() => {
    if (!isVisible || !isCompleted || activeTasks.size === 0) return
    const timer = setTimeout(() => {
      Animated.timing(scaleAnim, {
        toValue: 0,
        duration: 300,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start(() => {
        setIsVisible(false)
        setActiveTasks(new Map())
      })
    }, 4000)
    return () => { clearTimeout(timer) }
  }, [isVisible, isCompleted, activeTasks.size, scaleAnim])


  const handlePress = () => {
    // 只跳转到下载管理查看详情，不再顺手把球清掉（D16：点一下就消失且看不到进度汇总）
    navigations.pushDownloadManagerScreen(commonState.componentIds[commonState.componentIds.length - 1]?.id)
  }

  if (!isVisible) return null

  return (
    <Animated.View
      style={[
        styles.container,
        {
          // 悬浮在迷你播放器胶囊上方：胶囊 + tab 栏最高约到 safeAreaBottom + 150，
          // 原 bottom:70 会与播放器/tab 栏重叠
          bottom: 160 + safeAreaBottom,
        },
        { transform: [{ scale: scaleAnim }] },
      ]}
    >
      <TouchableOpacity onPress={handlePress}>
        <Progress.Circle
          size={50}
          progress={totalProgress}
          showsText={false}
          color={isCompleted ? settledColor : theme['c-primary']}
          unfilledColor="rgba(0,0,0,0.2)"
          borderWidth={0}
          thickness={3}
        />
        <View style={styles.iconContainer}>
          <Icon name={isCompleted ? (hasError ? 'close' : 'checkbox-marked') : 'download-2'} size={22} color={isCompleted ? settledColor : theme['c-primary-font-active']} />
        </View>
        {pendingCount > 0 ? (
          <View style={styles.badge}>
            <Text size={9} color="#fff">{pendingCount > 99 ? '99+' : pendingCount}</Text>
          </View>
        ) : null}
      </TouchableOpacity>
    </Animated.View>
  )
})

const styles = createStyle({
  container: {
    position: 'absolute',
    right: 15,
    zIndex: 100,
  },
  iconContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: '#e5484d',
    justifyContent: 'center',
    alignItems: 'center',
  },
})
