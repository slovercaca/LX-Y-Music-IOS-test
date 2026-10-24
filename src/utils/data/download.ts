import { getData, saveData } from '@/plugins/storage'
import { storageDataPrefix } from '@/config/constant'

const DOWNLOAD_TASKS_KEY = storageDataPrefix.downloadList

export const normalizeDownloadTasks = (tasks: LX.Download.DownloadTask[]): LX.Download.DownloadTask[] =>
  tasks.map(task => {
    // 中存疑-25：存量旧任务补齐 metadataStatus 默认值，防渲染期裸解引用闪退
    const withMeta = task.metadataStatus
      ? task
      : { ...task, metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' } as LX.Download.DownloadTask['metadataStatus'] }
    if (withMeta.status === 'downloading' || withMeta.status === 'waiting') {
      return { ...withMeta, status: 'paused' }
    }
    return withMeta
  })

export const normalizeDownloadTasksForSync = (tasks: LX.Download.DownloadTask[]): LX.Download.DownloadTask[] =>
  tasks.map(task => ({
    ...task,
    // P1（2026-10-12）：filePath 是本机绝对路径（含 iOS 沙盒 UUID），
    // 同步到异设备/重装后必失效。同步时剥离，接收端按需重建。
    filePath: '',
    status: 'paused',
    errorMsg: '',
    isRemoteSynced: false,
    progress: {
      ...task.progress,
      percent: 0,
      speed: '',
      downloaded: 0,
    },
    metadataStatus: {
      cover: 'pending',
      lyric: 'pending',
      tags: 'pending',
    },
  }))

export const normalizeRemoteSyncedDownloadTasks = (tasks: LX.Download.DownloadTask[]): LX.Download.DownloadTask[] =>
  normalizeDownloadTasksForSync(tasks).map(task => ({
    ...task,
    isRemoteSynced: true,
  }))

export const getDownloadTasks = async(): Promise<LX.Download.DownloadTask[]> => {
  const tasks = await getData<LX.Download.DownloadTask[]>(DOWNLOAD_TASKS_KEY)
  // 存疑处理：存储被写成非数组时此前 .map 抛错——形状守卫兜底为空数组
  return normalizeDownloadTasks(Array.isArray(tasks) ? tasks : [])
}

export const saveDownloadTasks = async(tasks: LX.Download.DownloadTask[]) => {
  await saveData(DOWNLOAD_TASKS_KEY, tasks)
}
