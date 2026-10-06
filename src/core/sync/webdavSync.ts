import * as webdav from '@/utils/webdav'
import { runWithWebDAVFailover } from './webdavFailover'
import { overwriteListFull } from '@/core/list'
import { filterSensitiveSettingsForSync, getAllDataForSync } from './syncHelpers'
import { confirmDialog, toast } from '@/utils/tools'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { debounce } from '@/utils/common'
import { getOperationQueue, clearOperationQueue, loadOperationQueue } from './opQueue'
import { applyListOperation } from '@/utils/listManage'
import { overwriteUserApis } from '@/core/userApi.ts'
import { getPlayHistory, savePlayHistory } from '@/utils/data'
import {
  normalizeDownloadTasksForSync,
  normalizeRemoteSyncedDownloadTasks,
  saveDownloadTasks,
} from '@/utils/data/download'
import downloadState from '@/store/download/state'

/**
 * WebDAV 数据同步（重写版）。
 *
 * 同步内容：「我的」歌单（含默认/喜欢/自建/临时列表）、播放历史、下载任务、
 * 设置、自定义音源。
 *
 * 兼容承诺（100%）：
 * - 设置键不变：sync.webdav.enable / syncLists / syncPlayHistory /
 *   syncDownloadTasks / path / lastSyncTimeLists / syncCookies 等
 * - 远端路径不变：<sync.webdav.path>/playlists.json、settings.json、user_apis.json
 * - 备份格式不变：{ version: '2', lastModified, data, playHistory?, downloadTasks? }
 * - 合并语义不变：操作队列重放、播放历史/下载任务按 id 合并（本地优先）、
 *   首次同步弹窗、冲突弹窗
 * - 操作队列表存储键不变（opQueue.ts）
 */

// ---------------------------------------------------------------------------
// 远端路径
// ---------------------------------------------------------------------------

const remoteDir = (): string => {
  const path = settingState.setting['sync.webdav.path'] || '/LX_Music/'
  return '/' + String(path).replace(/^\/|\/$/g, '')
}

const remoteListsPath = () => `${remoteDir()}/playlists.json`
const remoteSettingsPath = () => `${remoteDir()}/settings.json`
const remoteUserApisPath = () => `${remoteDir()}/user_apis.json`

// ---------------------------------------------------------------------------
// 备份格式
// ---------------------------------------------------------------------------

interface ListsSyncFile {
  version?: string
  lastModified: number
  data: LX.List.ListDataFull
  playHistory?: LX.Player.PlayHistoryItem[]
  downloadTasks?: LX.Download.DownloadTask[]
}

interface ListsSyncExtraData {
  playHistory: LX.Player.PlayHistoryItem[]
  downloadTasks: LX.Download.DownloadTask[]
}

const normalizeRemoteListsData = (remoteData: any): ListsSyncFile => ({
  ...remoteData,
  data: remoteData.data,
  lastModified: remoteData.lastModified ?? 0,
  playHistory: Array.isArray(remoteData.playHistory) ? remoteData.playHistory : undefined,
  downloadTasks: Array.isArray(remoteData.downloadTasks) ? remoteData.downloadTasks : undefined,
})

/** 合并时暂存的"本地新增历史/任务"，uploadLists 消费一次后清空 */
let pendingExtraData: ListsSyncExtraData | null = null

const wrapSyncFile = (data: unknown, extra?: Record<string, unknown>) => ({
  version: '2',
  lastModified: Date.now(),
  data,
  ...extra,
})

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

async function uploadUserApis(): Promise<number> {
  const { userApis } = await getAllDataForSync()
  const file = wrapSyncFile(userApis)
  await webdav.uploadFile(remoteUserApisPath(), JSON.stringify(file))
  return file.lastModified
}

async function uploadLists(listsData: LX.List.ListDataFull): Promise<number> {
  const { playHistory, downloadTasks } = pendingExtraData ?? await getAllDataForSync()
  pendingExtraData = null
  const extra: Record<string, unknown> = {}
  if (settingState.setting['sync.webdav.syncPlayHistory']) extra.playHistory = playHistory
  if (settingState.setting['sync.webdav.syncDownloadTasks']) extra.downloadTasks = downloadTasks
  const file = wrapSyncFile(listsData, extra)
  await webdav.uploadFile(remoteListsPath(), JSON.stringify(file))
  updateSetting({ 'sync.webdav.lastSyncTimeLists': file.lastModified })
  return file.lastModified
}

async function uploadSettings(): Promise<number> {
  // sync.webdav.syncCookies 开启时，上传设置包含平台 cookie
  const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
  const { settings } = await getAllDataForSync(includeCookies)
  const file = wrapSyncFile(settings)
  await webdav.uploadFile(remoteSettingsPath(), JSON.stringify(file))
  return file.lastModified
}

/**
 * 自动同步设置（2026-10-06）：
 * - 用内容 hash 检测本地是否有变化，避免无变化时重复上传（防双设备 ping-pong）
 * - 时间戳 last-write-wins：远端新则下载，本地变则上传
 * - hash 存的是过滤敏感键后的设置 JSON，确保上传/下载/比较用同一口径
 */
async function syncSettingsAuto(): Promise<void> {
  if (settingState.setting['sync.webdav.syncSettings'] === false) return
  const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
  const { settings } = await getAllDataForSync(includeCookies)
  const localHash = JSON.stringify(settings)
  const lastHash = settingState.setting['sync.webdav.lastSyncSettingsHash'] ?? ''
  const localTimestamp = settingState.setting['sync.webdav.lastSyncTimeSettings'] ?? 0

  const remoteContent = await webdav.downloadFile(remoteSettingsPath())
  if (remoteContent === null) {
    // 云端没有：本地有变化才上传
    if (lastHash !== localHash) {
      webDAVLog.info('[Sync] 上传设置（云端无文件）')
      const ts = await uploadSettings()
      updateSetting({ 'sync.webdav.lastSyncTimeSettings': ts, 'sync.webdav.lastSyncSettingsHash': localHash })
    }
    return
  }

  let remoteData: any
  try {
    remoteData = JSON.parse(remoteContent)
  } catch {
    webDAVLog.warn('[Sync] 远端 settings.json 解析失败，跳过设置自动同步')
    return
  }
  const remoteTimestamp = remoteData.lastModified ?? 0

  if (remoteTimestamp > localTimestamp) {
    // 远端更新：下载覆盖本地（走敏感键过滤，口径与上传一致）
    webDAVLog.info('[Sync] 下载设置（远端更新）')
    const filtered = filterSensitiveSettingsForSync(remoteData.data, includeCookies)
    updateSetting(filtered)
    updateSetting({
      'sync.webdav.lastSyncTimeSettings': remoteTimestamp,
      'sync.webdav.lastSyncSettingsHash': JSON.stringify(filtered),
    })
  } else if (lastHash !== localHash) {
    // 本地有变化：上传
    webDAVLog.info('[Sync] 上传设置（本地有变化）')
    const ts = await uploadSettings()
    updateSetting({ 'sync.webdav.lastSyncTimeSettings': ts, 'sync.webdav.lastSyncSettingsHash': localHash })
  }
}

/**
 * 自动同步自定义音源/插件（2026-10-06）：逻辑同 syncSettingsAuto，
 * hash 口径为 getAllDataForSync 返回的 userApis（list + scripts）。
 */
async function syncUserApisAuto(): Promise<void> {
  if (settingState.setting['sync.webdav.syncUserApis'] === false) return
  const { userApis } = await getAllDataForSync()
  const localHash = JSON.stringify(userApis)
  const lastHash = settingState.setting['sync.webdav.lastSyncUserApisHash'] ?? ''
  const localTimestamp = settingState.setting['sync.webdav.lastSyncTimeUserApis'] ?? 0

  const remoteContent = await webdav.downloadFile(remoteUserApisPath())
  if (remoteContent === null) {
    if (lastHash !== localHash) {
      webDAVLog.info('[Sync] 上传自定义音源（云端无文件）')
      const ts = await uploadUserApis()
      updateSetting({ 'sync.webdav.lastSyncTimeUserApis': ts, 'sync.webdav.lastSyncUserApisHash': localHash })
    }
    return
  }

  let remoteData: any
  try {
    remoteData = JSON.parse(remoteContent)
  } catch {
    webDAVLog.warn('[Sync] 远端 user_apis.json 解析失败，跳过音源自动同步')
    return
  }
  const remoteTimestamp = remoteData.lastModified ?? 0

  if (remoteTimestamp > localTimestamp) {
    webDAVLog.info('[Sync] 下载自定义音源（远端更新）')
    await overwriteUserApis(remoteData.data)
    updateSetting({
      'sync.webdav.lastSyncTimeUserApis': remoteTimestamp,
      'sync.webdav.lastSyncUserApisHash': JSON.stringify(remoteData.data),
    })
  } else if (lastHash !== localHash) {
    webDAVLog.info('[Sync] 上传自定义音源（本地有变化）')
    const ts = await uploadUserApis()
    updateSetting({ 'sync.webdav.lastSyncTimeUserApis': ts, 'sync.webdav.lastSyncUserApisHash': localHash })
  }
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/** 播放历史合并：按 id 去重，本地优先，取最近 5000 条 */
const mergePlayHistory = (
  localHistory: LX.Player.PlayHistoryItem[],
  remoteHistory?: LX.Player.PlayHistoryItem[],
): LX.Player.PlayHistoryItem[] => {
  const historyMap = new Map<string, LX.Player.PlayHistoryItem>()
  for (const item of remoteHistory ?? []) historyMap.set(item.id, item)
  for (const item of localHistory) historyMap.set(item.id, item)
  return [...historyMap.values()]
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, 5000)
}

/** 下载任务合并（上传用）：按 id 去重，本地优先 */
const mergeDownloadTasks = (
  localTasks: LX.Download.DownloadTask[],
  remoteTasks?: LX.Download.DownloadTask[],
): LX.Download.DownloadTask[] => {
  const taskMap = new Map<string, LX.Download.DownloadTask>()
  for (const task of remoteTasks ?? []) taskMap.set(task.id, task)
  for (const task of localTasks) taskMap.set(task.id, task)
  return normalizeDownloadTasksForSync([...taskMap.values()].sort((a, b) => b.createdAt - a.createdAt))
}

/** 下载任务合并（落本地用）：远端任务先做同步归一化 */
const mergeDownloadTasksForLocal = (
  localTasks: LX.Download.DownloadTask[],
  remoteTasks?: LX.Download.DownloadTask[],
): LX.Download.DownloadTask[] => {
  const taskMap = new Map<string, LX.Download.DownloadTask>()
  for (const task of normalizeRemoteSyncedDownloadTasks(remoteTasks ?? [])) taskMap.set(task.id, task)
  for (const task of localTasks) taskMap.set(task.id, task)
  return [...taskMap.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** 远端任务落本地：保留本地的运行态（status/progress 等），只同步任务本身 */
const adaptRemoteTasksForLocal = (remoteTasks: LX.Download.DownloadTask[]): LX.Download.DownloadTask[] => {
  const localTaskMap = new Map(downloadState.tasks.map(task => [task.id, task]))
  return normalizeRemoteSyncedDownloadTasks(remoteTasks)
    .map(task => {
      const localTask = localTaskMap.get(task.id)
      if (!localTask) return task
      return {
        ...task,
        status: localTask.status,
        errorMsg: localTask.errorMsg,
        progress: localTask.progress,
        metadataStatus: localTask.metadataStatus,
        isRemoteSynced: localTask.isRemoteSynced,
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** 远端数据直接覆盖本地（下载/首次同步/冲突解决用） */
async function applyRemoteExtraData(remoteData: ListsSyncFile): Promise<void> {
  if (settingState.setting['sync.webdav.syncPlayHistory'] && Array.isArray(remoteData.playHistory)) {
    await savePlayHistory(remoteData.playHistory)
    global.app_event.playHistoryUpdated()
  }
  if (settingState.setting['sync.webdav.syncDownloadTasks'] && Array.isArray(remoteData.downloadTasks)) {
    const tasks = adaptRemoteTasksForLocal(remoteData.downloadTasks)
    downloadState.tasks = tasks
    await saveDownloadTasks(tasks)
    global.app_event.download_list_changed()
  }
}

/** 合并后的历史/任务回写本地（合并上传后用） */
async function applyMergedExtraData(remoteData: ListsSyncFile): Promise<void> {
  if (settingState.setting['sync.webdav.syncPlayHistory']) {
    const localHistory = await getPlayHistory()
    await savePlayHistory(mergePlayHistory(localHistory, remoteData.playHistory))
    global.app_event.playHistoryUpdated()
  }
  if (settingState.setting['sync.webdav.syncDownloadTasks']) {
    const tasks = mergeDownloadTasksForLocal(downloadState.tasks, remoteData.downloadTasks)
    downloadState.tasks = tasks
    await saveDownloadTasks(tasks)
    global.app_event.download_list_changed()
  }
}

/** 本次要上传的合并数据（历史 + 任务） */
const buildMergedExtraData = async(remoteData: ListsSyncFile): Promise<ListsSyncExtraData> => {
  const localHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? await getPlayHistory() : []
  return {
    playHistory: settingState.setting['sync.webdav.syncPlayHistory']
      ? mergePlayHistory(localHistory, remoteData.playHistory)
      : [],
    downloadTasks: settingState.setting['sync.webdav.syncDownloadTasks']
      ? mergeDownloadTasks(downloadState.tasks, remoteData.downloadTasks)
      : [],
  }
}

/** 本地历史/任务与远端是否有差异（决定是否需要上传） */
const hasLocalExtraDataChanges = async(remoteData: ListsSyncFile): Promise<boolean> => {
  const localHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? await getPlayHistory() : []
  const localDownloads = settingState.setting['sync.webdav.syncDownloadTasks']
    ? normalizeDownloadTasksForSync(downloadState.tasks)
    : []
  const remoteHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? (remoteData.playHistory ?? []) : []
  const remoteDownloads = settingState.setting['sync.webdav.syncDownloadTasks']
    ? normalizeDownloadTasksForSync(remoteData.downloadTasks ?? [])
    : []
  return JSON.stringify({ playHistory: localHistory, downloadTasks: localDownloads })
    !== JSON.stringify({ playHistory: remoteHistory, downloadTasks: remoteDownloads })
}

// ---------------------------------------------------------------------------
// 同步守卫：防重入 + 配置检查 + 故障转移 + 错误上报
// ---------------------------------------------------------------------------

let isSyncing = false

const isSyncConfigured = (): boolean =>
  !!(settingState.setting['sync.webdav.enable'] && settingState.setting['sync.webdav.url'])

/**
 * 手动操作的统一守卫：防重入、配置检查、套故障转移、失败 toast。
 * 返回 false 表示前置条件不满足（调用方直接返回）。
 */
async function runGuarded(label: string, task: () => Promise<void>): Promise<boolean> {
  if (!checkSyncReady()) return false
  isSyncing = true
  try {
    await runWithWebDAVFailover(task)
    return true
  } catch (error: any) {
    webDAVLog.error(`[${label}] Failed: ${error.stack ?? error.message}`)
    toast(`${label}失败: ${error.message}`, 'long')
    return false
  } finally {
    isSyncing = false
  }
}

/**
 * 前置检查（弹窗前调用，与旧版顺序一致：先判"同步中/未配置"，再弹确认框）。
 * runGuarded 内会再查一次：用户在确认框停留期间自动同步可能已启动，
 * 第二次检查能正确拦下。
 */
function checkSyncReady(): boolean {
  if (isSyncing) {
    toast('正在同步中，请稍后...')
    return false
  }
  if (!isSyncConfigured()) {
    toast('请先启用并配置 WebDAV 同步')
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 手动上传 / 下载
// ---------------------------------------------------------------------------

/** 同步进度回调：0-1 之间的小数，UI 据此画进度条 */
export type SyncProgressCallback = (progress: number, stage: string) => void

export async function manualUploadSettingsAndApis(onProgress?: SyncProgressCallback): Promise<void> {
  if (!checkSyncReady()) return
  const confirm = await confirmDialog({
    title: '确认上传',
    message: '这将使用本地的“设置”和“自定义音源”完全覆盖云端的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '上传',
  })
  if (!confirm) return

  toast('开始上传...')
  await runGuarded('上传', async() => {
    onProgress?.(0.1, '正在上传设置…')
    const settingsTs = await uploadSettings()
    onProgress?.(0.5, '正在上传自定义音源…')
    const apisTs = await uploadUserApis()
    // 同步 hash/时间戳，避免自动同步紧接着重复上传
    const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
    const { settings, userApis } = await getAllDataForSync(includeCookies)
    updateSetting({
      'sync.webdav.lastSyncTimeSettings': settingsTs,
      'sync.webdav.lastSyncSettingsHash': JSON.stringify(settings),
      'sync.webdav.lastSyncTimeUserApis': apisTs,
      'sync.webdav.lastSyncUserApisHash': JSON.stringify(userApis),
    })
    onProgress?.(1, '上传完成')
    toast('上传成功！')
  })
}

export async function manualDownloadSettingsAndApis(onProgress?: SyncProgressCallback): Promise<void> {
  if (!checkSyncReady()) return
  const confirm = await confirmDialog({
    title: '确认下载',
    message: '这将使用云端的“设置”和“自定义音源”完全覆盖本地的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return

  toast('开始下载...')
  await runGuarded('下载', async() => {
    onProgress?.(0.1, '正在下载设置…')
    const remoteSettingsContent = await webdav.downloadFile(remoteSettingsPath())
    if (remoteSettingsContent) {
      const remoteSettingsData = JSON.parse(remoteSettingsContent)
      // sync.webdav.syncCookies 开启时，下载设置包含平台 cookie
      const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
      updateSetting(filterSensitiveSettingsForSync(remoteSettingsData.data, includeCookies))
    } else {
      toast('云端未找到设置文件，跳过设置同步')
    }

    onProgress?.(0.5, '正在下载自定义音源…')
    const remoteUserApisContent = await webdav.downloadFile(remoteUserApisPath())
    if (remoteUserApisContent) {
      const remoteApisData = JSON.parse(remoteUserApisContent)
      await overwriteUserApis(remoteApisData.data)
    } else {
      toast('云端未找到自定义音源文件，跳过音源同步')
    }
    onProgress?.(1, '下载完成')

    toast('下载同步完成！')
  })
}

export async function manualUploadLists(onProgress?: SyncProgressCallback): Promise<void> {
  if (!checkSyncReady()) return
  const confirm = await confirmDialog({
    title: '确认上传歌单',
    message: '这将使用本地的“所有歌单”完全覆盖云端的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '上传',
  })
  if (!confirm) return

  toast('开始上传歌单...')
  await runGuarded('上传', async() => {
    onProgress?.(0.1, '正在准备歌单数据…')
    const { lists } = await getAllDataForSync()
    onProgress?.(0.4, '正在上传歌单…')
    await uploadLists(lists)
    onProgress?.(0.8, '正在清理同步队列…')
    await clearOperationQueue()
    onProgress?.(1, '上传完成')
    toast('歌单上传成功！')
  })
}

export async function manualDownloadLists(onProgress?: SyncProgressCallback): Promise<void> {
  if (!checkSyncReady()) return
  const confirm = await confirmDialog({
    title: '确认下载歌单',
    message: '这将使用云端的“所有歌单”完全覆盖本地的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return

  toast('开始下载歌单...')
  await runGuarded('下载', async() => {
    onProgress?.(0.1, '正在下载歌单…')
    const remoteListsContent = await webdav.downloadFile(remoteListsPath())
    if (remoteListsContent) {
      onProgress?.(0.4, '正在解析歌单数据…')
      const remoteData = normalizeRemoteListsData(JSON.parse(remoteListsContent))
      onProgress?.(0.6, '正在覆盖本地歌单…')
      await overwriteListFull(remoteData.data)
      await applyRemoteExtraData(remoteData)
      await clearOperationQueue()
      updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteData.lastModified })
      onProgress?.(1, '下载完成')
      toast('歌单下载同步完成！')
    } else {
      toast('云端未找到歌单文件')
    }
  })
}

// ---------------------------------------------------------------------------
// 自动同步：歌单变更后 3 秒触发
// ---------------------------------------------------------------------------

let listsChanged = false
let settingsChanged = false

void loadOperationQueue()

const debouncedSync = debounce(() => {
  if (!settingState.setting['sync.webdav.enable']) return
  // 歌单同步需要 syncLists 开；设置/插件同步有各自独立开关，
  // 即使歌单同步关闭，只要设置/插件同步开也要跑
  const needLists = settingState.setting['sync.webdav.syncLists'] && listsChanged
  const needSettings = settingState.setting['sync.webdav.syncSettings'] !== false && settingsChanged
  const needApis = settingState.setting['sync.webdav.syncUserApis'] !== false && settingsChanged
  if (needLists || needSettings || needApis) {
    void triggerWebDAVSync(false).finally(() => {
      listsChanged = false
      settingsChanged = false
    })
  }
}, 3000)

export const markListsChanged = (): void => {
  if (!settingState.setting['sync.webdav.enable']) return
  listsChanged = true
  debouncedSync()
}

/**
 * 标记设置/插件已变更（2026-10-06）：由 core/common.ts 的 updateSetting 统一调用，
 * 3 秒防抖后触发 triggerWebDAVSync，自动上传设置与自定义音源。
 * 注意：只标记，不立即同步；debouncedSync 内按开关决定是否真的跑。
 */
export const markSettingsChanged = (): void => {
  if (!settingState.setting['sync.webdav.enable']) return
  // 两个开关都关就不用标记了
  if (settingState.setting['sync.webdav.syncSettings'] === false && settingState.setting['sync.webdav.syncUserApis'] === false) return
  settingsChanged = true
  debouncedSync()
}

// ---------------------------------------------------------------------------
// 主同步流程
// ---------------------------------------------------------------------------

/** 首次同步：云端已有数据，让用户二选一（上传覆盖云端 / 下载覆盖本地） */
async function resolveFirstSync(remoteData: ListsSyncFile): Promise<'done' | 'cancelled'> {
  webDAVLog.info('[Sync] First sync detected with existing remote data. Prompting user.')
  const userChoice = await confirmDialog({
    title: '首次同步确认',
    message: '云端已存在歌单数据。由于这是该设备上首次同步，请选择您的操作：\n\n“下载”：将使用云端数据覆盖本地（推荐用于恢复数据）。\n“上传”：将使用本地数据覆盖云端（请务必确认本地数据是您最终想要的版本）。',
    cancelButtonText: '下载云端并覆盖本地',
    confirmButtonText: '上传本地并覆盖云端',
  })

  if (userChoice === true) {
    webDAVLog.info('[Sync] User chose to upload local state during first sync.')
    const { lists: currentLocalLists } = await getAllDataForSync()
    await uploadLists(currentLocalLists)
    await clearOperationQueue()
    toast('本地歌单已上传覆盖云端！')
    return 'done'
  }
  if (userChoice === false) {
    webDAVLog.info('[Sync] User chose to download remote state during first sync.')
    await overwriteListFull(remoteData.data)
    await applyRemoteExtraData(remoteData)
    await clearOperationQueue()
    updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteData.lastModified })
    toast('已从云端同步歌单数据到本地！')
    return 'done'
  }
  webDAVLog.info('[Sync] First sync resolution cancelled.')
  return 'cancelled'
}

export async function triggerWebDAVSync(isManual = false): Promise<void> {
  if (isSyncing) {
    if (isManual) toast('正在同步中，请稍后...')
    return
  }
  if (!isSyncConfigured()) {
    if (isManual) toast('请先启用并配置 WebDAV 同步')
    return
  }

  isSyncing = true
  if (isManual) toast('开始同步歌单...')

  try {
    await runWithWebDAVFailover(async() => {
      const remoteListsContent = await webdav.downloadFile(remoteListsPath())

      // 云端没有歌单文件：直接上传本地
      if (remoteListsContent === null) {
        webDAVLog.info('[Sync] Remote lists not found. Uploading local state.')
        const { lists } = await getAllDataForSync()
        await uploadLists(lists)
        await clearOperationQueue()
        if (isManual) toast('歌单上传成功！')
        return
      }

      const remoteData = normalizeRemoteListsData(JSON.parse(remoteListsContent))
      const remoteTimestamp = remoteData.lastModified
      const localTimestamp = settingState.setting['sync.webdav.lastSyncTimeLists'] ?? 0

      // 首次同步（本地无时间戳但云端有数据）
      if (localTimestamp === 0) {
        const result = await resolveFirstSync(remoteData)
        if (result === 'cancelled' && isManual) toast('同步已取消')
        return
      }

      const hasRemoteUpdate = remoteTimestamp > localTimestamp
      const localOpQueue = getOperationQueue()
      const hasLocalChanges = localOpQueue.length > 0 || listsChanged || await hasLocalExtraDataChanges(remoteData)

      if (hasRemoteUpdate) {
        webDAVLog.info('[Sync] Remote is newer. Starting merge process.')
        let mergedData = remoteData.data
        let conflictOccurred = false

        if (hasLocalChanges) {
          pendingExtraData = await buildMergedExtraData(remoteData)
          webDAVLog.info(`[Sync] Applying ${localOpQueue.length} local operations onto remote data.`)
          try {
            for (const op of localOpQueue) {
              mergedData = await applyListOperation(mergedData, op)
            }
          } catch (error: any) {
            conflictOccurred = true
            webDAVLog.error('[Sync] A true conflict occurred during operation merge:', error.message)
          }
        }

        if (conflictOccurred) {
          // 真冲突：用户二选一（需要 remoteData，内联处理）
          pendingExtraData = null
          const userChoice = await confirmDialog({
            title: '同步冲突',
            message: '云端和本地的歌单修改无法自动合并。请选择要保留的版本：\n\n为防止意外，建议在操作前先备份当前歌单。',
            cancelButtonText: '云端覆盖本地',
            confirmButtonText: '本地覆盖云端',
          })
          if (userChoice === true) {
            webDAVLog.info('[Sync] Conflict resolved by user: Force pushing local state.')
            const { lists: currentLocalLists } = await getAllDataForSync()
            await uploadLists(currentLocalLists)
            await clearOperationQueue()
            toast('已强制使用本地歌单覆盖云端！')
          } else if (userChoice === false) {
            webDAVLog.info('[Sync] Conflict resolved by user: Force pulling remote state.')
            await overwriteListFull(remoteData.data)
            await applyRemoteExtraData(remoteData)
            await clearOperationQueue()
            updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteTimestamp })
            toast('已从云端同步歌单，本地更改已放弃！')
          } else {
            webDAVLog.info('[Sync] Conflict resolution cancelled by user.')
            toast('操作已取消')
          }
        } else {
          webDAVLog.info('[Sync] Merge successful or only remote changes detected.')
          await overwriteListFull(mergedData)
          if (hasLocalChanges) {
            await uploadLists(mergedData)
            await applyMergedExtraData(remoteData)
            if (isManual) toast('歌单合并同步成功！')
          } else {
            await applyRemoteExtraData(remoteData)
            updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteTimestamp })
            if (isManual) toast('歌单已从云端同步！')
          }
          await clearOperationQueue()
        }
      } else if (hasLocalChanges) {
        webDAVLog.info('[Sync] Local has unsynced changes. Uploading.')
        const { lists: currentLocalLists } = await getAllDataForSync()
        await uploadLists(currentLocalLists)
        await clearOperationQueue()
        if (isManual) toast('本地歌单已上传！')
      } else if (isManual) {
        webDAVLog.info('[Sync] Lists are up to date.')
        toast('歌单已是最新，无需同步')
      }

      // 自动同步设置与自定义音源（2026-10-06）：歌单同步完成后顺带执行，
      // 各自有独立开关 sync.webdav.syncSettings / sync.webdav.syncUserApis，
      // 内部用 hash 防重复上传、用时间戳做 last-write-wins。
      // 注意：放在 failover 回调内，享受多服务器故障转移。
      try {
        await syncSettingsAuto()
      } catch (error: any) {
        webDAVLog.warn('[Sync] 设置自动同步失败', { error: error?.message ?? error })
      }
      try {
        await syncUserApisAuto()
      } catch (error: any) {
        webDAVLog.warn('[Sync] 自定义音源自动同步失败', { error: error?.message ?? error })
      }
    })
  } catch (error: any) {
    webDAVLog.error(`[Sync] Sync failed: ${error.stack ?? error.message}`)
    toast(`同步失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}
