import state from './state'
import DownloadTask = LX.Download.DownloadTask
import { saveDownloadTasks } from '@/utils/data/download'
import { throttle } from '@/utils'
import { markListsChanged } from '@/core/sync/webdavSync'

const throttledSave = throttle(() => {
  void saveDownloadTasks(state.tasks)
}, 1000)

const shouldSyncTaskChange = (updatedFields: Partial<DownloadTask>) => {
  const ignoredSyncKeys: Array<keyof DownloadTask> = [
    'progress',
    'status',
    'errorMsg',
    'metadataStatus',
  ]
  return Object.keys(updatedFields).some(key => !ignoredSyncKeys.includes(key as keyof DownloadTask))
}

export default {
  setTasks(tasks: LX.Download.DownloadTask[]) {
    state.tasks = tasks
    global.app_event.download_list_changed()
    // 中：watchList 监听的是 downloadListUpdate（播放中下载列表的联动），
    // 此前从无人 emit——播下载列表时删/覆盖任务不重算 playIndex、不切歌
    global.app_event.downloadListUpdate()
  },
  addTask(task: DownloadTask) {
    state.tasks.unshift(task)
    global.app_event.download_list_changed()
    global.app_event.download_task_add(task)
    markListsChanged()
    throttledSave()
  },
  updateTask(id: string, updatedFields: Partial<DownloadTask>) {
    const taskIndex = state.tasks.findIndex(t => t.id === id)
    if (taskIndex > -1) {
      Object.assign(state.tasks[taskIndex], updatedFields)
      // 中-20：纯进度更新不广播 list_changed——它会让 useDownloadTasks 订阅方
      // 整体刷新，「本地与下载」页的扫描回调随之换引用、以 ~250ms 节拍反复
      // 全量扫盘。进度有专门的 download_progress_update 事件，行组件各自订阅。
      const hasNonProgressChange = Object.keys(updatedFields).some(k => k !== 'progress')
      if (hasNonProgressChange) global.app_event.download_list_changed()
      if ('progress' in updatedFields) {
        // P2: 用 in 判断，progress: 0 不会被当 falsy 跳过
        global.app_event.download_progress_update({ id, progress: updatedFields.progress })
      }
      if (updatedFields.status) {
        global.app_event.download_status_update({ id, status: updatedFields.status, errorMsg: updatedFields.errorMsg })
      }
      if (updatedFields.metadataStatus) {
        global.app_event.download_metadata_update({ id, metadataStatus: updatedFields.metadataStatus })
      }
      if (updatedFields.actualQuality) {
        global.app_event.download_quality_update({ id, actualQuality: updatedFields.actualQuality })
      }
      if (shouldSyncTaskChange(updatedFields)) markListsChanged()
      throttledSave()
    }
  },
  removeTask(id: string) {
    const index = state.tasks.findIndex(t => t.id === id)
    if (index > -1) {
      state.tasks.splice(index, 1)
      global.app_event.download_list_changed()
      global.app_event.downloadListUpdate() // 中：同 setTasks，补桥接
      markListsChanged()
      // 低：删除立即落盘——1 秒节流期内杀 App，已删任务重启会「复活」
      void saveDownloadTasks(state.tasks)
    }
  },
  clearTasks() {
    state.tasks = []
    global.app_event.download_list_changed()
    global.app_event.downloadListUpdate() // 中：同 setTasks，补桥接
    markListsChanged()
    void saveDownloadTasks(state.tasks) // 低：同 removeTask，立即落盘
  },
}
