import { getData, saveData } from '@/plugins/storage'
import { storageDataPrefix } from '@/config/constant'

const DOWNLOAD_TASKS_KEY = storageDataPrefix.downloadList

export const normalizeDownloadTasks = (tasks: LX.Download.DownloadTask[]): LX.Download.DownloadTask[] =>
  tasks.map(task => {
    if (task.status === 'downloading' || task.status === 'waiting') {
      return { ...task, status: 'paused' }
    }
    return task
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
  return normalizeDownloadTasks(tasks || [])
}

export const saveDownloadTasks = async(tasks: LX.Download.DownloadTask[]) => {
  await saveData(DOWNLOAD_TASKS_KEY, tasks)
}
