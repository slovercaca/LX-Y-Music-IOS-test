import * as webdav from '@/utils/webdav'
import { describeWebDAVError } from '@/utils/webdav'
import { runWithWebDAVFailover } from './webdavFailover'
import { overwriteListFull } from '@/core/list'
import { filterSensitiveSettingsForSync, getAllDataForSync } from './syncHelpers'
import { confirmDialog, toast } from '@/utils/tools'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { friendlyWebDAVError } from '@/core/webdavMusic/client'
import { debounce } from '@/utils/common'
import { getOperationQueue, clearOperationQueue, clearOperationQueueSnapshot, loadOperationQueue, whenOperationQueueReady } from './opQueue'
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
  // 2026-10-24 双斜杠修复：根目录时 path 为 '/'，旧写法先拼出 '/'
  // 再拼 '/settings.json'，得到 '//settings.json'（真机日志实锤）。
  // 该服务器会归一化所以上传能成功，但换不归一化的服务器会 404。
  // 根目录返回空串，拼接后正好是 '/settings.json'；非根目录返回
  // '/LX_Music' 之类，拼接后不变。首尾斜杠全部剥掉，嵌套路径不变。
  const stripped = String(path).replace(/^\/+|\/+$/g, '')
  return stripped ? `/${stripped}` : ''
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

// 中：远端歌单文件只验 JSON 语法不验结构时，缺 defaultList/loveList 的
// 合法 JSON 会以 undefined 覆盖本地两大核心歌单。覆盖前必须验结构。
const isValidListsData = (data: any): boolean => !!data
  && Array.isArray(data.defaultList)
  && Array.isArray(data.loveList)
  && Array.isArray(data.userList)

const normalizeRemoteListsData = (remoteData: any): ListsSyncFile => ({
  ...remoteData,
  data: remoteData.data,
  lastModified: remoteData.lastModified ?? 0,
  playHistory: Array.isArray(remoteData.playHistory) ? remoteData.playHistory : undefined,
  downloadTasks: Array.isArray(remoteData.downloadTasks) ? remoteData.downloadTasks : undefined,
})

/** 合并时暂存的"本地新增历史/任务"，uploadLists 消费一次后清空 */

/**
 * P1（2026-10-12）：安全解析远端同步文件。
 * 远端文件可能因上传中断而损坏（JSON 非法）；直接 JSON.parse 会抛错导致整个同步流程失败，
 * 且没有任何恢复路径。损坏时返回 null，调用方跳过本次同步（不碰本地数据，不上传覆盖）。
 */
/** 云端同步文件解析失败的会话级提示（自动同步会反复跑，每会话每类只弹一次，防刷屏） */
const parseFailedNotified = new Set<string>()

const safeParseSyncFile = (content: string, label: string, notify = true): any | null => {
  try {
    const parsed = JSON.parse(content)
    // 全量修复：只验 JSON 语法不够——合法但不是同步文件对象时
    // （如 "123"、"[]"、'"abc"'），下游会把 undefined 当数据覆盖本地。
    // 同步文件一定是带 version/data 的对象，非对象一律按损坏处理。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`远端${label}文件结构损坏：不是同步文件对象`)
    }
    return parsed
  } catch (error: any) {
    // 2026-10-24 真机日志：三个云端文件同时解析失败，但日志只给了
    // 解析器报错字符（" / r / a），看不出云端文件到底是什么内容，
    // 也没有恢复路径，导致“同步后重启仍无变化”。这里只记分类诊断，
    // 不记原文——设置文件可能含平台 Cookie，原文进日志不安全。
    const trimmed = String(content).trim()
    webDAVLog.error(`[Sync] 远端${label}文件已损坏（解析/结构失败），跳过本次同步`, {
      error: error?.message,
      length: content.length,
      firstChar: trimmed.charAt(0),
      startsWithBrace: trimmed.startsWith('{'),
      startsWithBracket: trimmed.startsWith('['),
      startsWithLT: trimmed.startsWith('<'),
      hasVersionKey: content.includes('"version"'),
    })
    // 恢复路径：损坏文件只能下载失败，不能下载；本地数据未动，
    // 同步页点“上传”以本地覆盖云端后，下一次同步即可恢复。
    if (notify || !parseFailedNotified.has(label)) {
      parseFailedNotified.add(label)
      toast(`云端${label}文件已损坏，同步已跳过；本地数据未动，用“上传”以本地覆盖可修复`, 'long')
    }
    return null
  }
}
let pendingExtraData: ListsSyncExtraData | null = null

const wrapSyncFile = (data: unknown, extra?: Record<string, unknown>, forcedLastModified?: number) => ({
  version: '2',
  lastModified: forcedLastModified ?? Date.now(),
  data,
  ...extra,
})

/**
 * 全量修复：单调时间戳。
 * 纯 Date.now() 在时钟回拨/跨设备时钟差时会让新上传的文件时间戳
 * 小于旧远端文件，下次同步又被旧文件下载覆盖、来回翻转。
 * 上传时把时间戳取成 max(现在, 已知旧远端时间戳+1)，保证新文件
 * 在时间戳上一定晚于它覆盖的旧文件；这不是完整的时钟同步方案，
 * 但能堵住“刚上传就被旧文件滚回来”这一类。
 */
const monotonicTimestamp = (remoteTimestamp?: number): number => {
  const now = Date.now()
  if (remoteTimestamp && Number.isFinite(remoteTimestamp)) return Math.max(now, remoteTimestamp + 1)
  return now
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

async function uploadUserApis(userApisData?: any, forcedLastModified?: number): Promise<number> {
  const { userApis } = userApisData ? { userApis: userApisData } : await getAllDataForSync()
  const file = wrapSyncFile(userApis, undefined, forcedLastModified)
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

async function uploadSettings(settingsData?: any, forcedLastModified?: number): Promise<number> {
  // sync.webdav.syncCookies 开启时，上传设置包含平台 cookie
  const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
  const { settings } = settingsData ? { settings: settingsData } : await getAllDataForSync(includeCookies)
  const file = wrapSyncFile(settings, undefined, forcedLastModified)
  await webdav.uploadFile(remoteSettingsPath(), JSON.stringify(file))
  return file.lastModified
}

/**
 * 自动同步设置（2026-10-06）：
 * - 用内容 hash 检测本地是否有变化，避免无变化时重复上传（防双设备 ping-pong）
 * - 时间戳 last-write-wins：远端新则下载，本地变则上传
 * - hash 存的是过滤敏感键后的设置 JSON，确保上传/下载/比较用同一口径
 */
/**
 * P1-6（2026-10-06）：计算设置 hash 时剔除同步元数据键自身。
 * 否则 hash 输入包含 `lastSyncSettingsHash`/`lastSyncTimeSettings`，
 * 每次上传后更新这俩键 → hash 必然变化 → 下次必再上传 → 双设备无限 ping-pong。
 */
const hashSettingsForSync = (settings: Record<string, unknown>): string => {
  const filtered: Record<string, unknown> = {}
  for (const key of Object.keys(settings)) {
    if (key.startsWith('sync.webdav.lastSync')) continue
    filtered[key] = settings[key]
  }
  return JSON.stringify(filtered)
}

// 中19：设置/音源双端冲突的会话级提示标志（每会话各弹一次，避免防抖反复弹）
let settingsConflictNotified = false
let userApisConflictNotified = false

async function syncSettingsAuto(): Promise<void> {
  if (settingState.setting['sync.webdav.syncSettings'] === false) return
  const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
  const { settings } = await getAllDataForSync(includeCookies)
  const localHash = hashSettingsForSync(settings as Record<string, unknown>)
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

  // 2026-10-24：此前这里裸 JSON.parse、只打一条无细节 warn，
  // 自动同步反复跑时既看不出云端文件是什么、也不提示恢复路径。
  // 改走安全解析（自动同步每会话每类只弹一次，见 safeParseSyncFile）。
  const remoteData = safeParseSyncFile(remoteContent, '设置', false)
  if (remoteData === null) return
  const remoteTimestamp = remoteData.lastModified ?? 0

  // 全量修复：无基线且远端时间戳缺失/为 0 时，无法判断谁新谁旧，
  // 绝不能直接用本地覆盖云端（此前正是这样丢数据的）。本轮跳过、
  // 基线不动，每会话提示一次，让用户在同步页手动选择上传或下载。
  if (lastHash === '' && !(remoteTimestamp > 0)) {
    webDAVLog.warn('[Sync] 首次同步且云端设置文件无时间戳，无法判断新旧，跳过自动同步', { remoteTimestamp })
    if (!settingsConflictNotified) {
      settingsConflictNotified = true
      toast('首次同步：云端已有设置文件但无时间戳，已跳过自动同步，请在同步页手动选择上传或下载', 'long')
    }
    return
  }

  // 2026-10-24 冲突卡死修复：无基线（lastHash 为空 = 从未同步过，如新设备）
  // 不是“本地改过”的证据——空串与任何本地 hash 都不等，旧条件会把首次
  // 同步误判成冲突、永远跳过自动下载。无基线时放行到下面的下载分支，
  // 由下载分支建立基线；只有已有基线且本地 hash 偏离基线时才算真冲突。
  const hasSettingsBaseline = lastHash !== ''
  if (remoteTimestamp > localTimestamp && hasSettingsBaseline && lastHash !== localHash) {
    // 中：远端更新且本地也有未同步变更——此前直接走下载覆盖，本地变更
    // 被静默丢弃、hash 还被改写成远端值无从察觉。设置无合并能力，改为
    // 跳过本轮（不推进时间戳/hash，两边数据都不动），每会话提示一次，
    // 用户可用手动上传/下载取舍
    webDAVLog.warn('[Sync] 设置在本地与云端都有修改，跳过本轮自动同步以防丢数据')
    if (!settingsConflictNotified) {
      settingsConflictNotified = true
      toast('设置在本地与另一台设备都有修改，已跳过自动覆盖，请手动同步确认', 'long')
    }
    return
  }

  if (remoteTimestamp > localTimestamp) {
    // 全量修复：设置 data 必须是对象，非对象（字符串/数组/数字）
    // 时不能展开进本地设置，否则会把索引当键写进去。
    if (!remoteData.data || typeof remoteData.data !== 'object' || Array.isArray(remoteData.data)) {
      webDAVLog.error('[Sync] 远端设置文件结构损坏（data 不是对象），跳过本次同步')
      return
    }
    // 远端更新：下载到本地。设置下载实际是合并（updateSetting 无法
    // 删除远端没有的本地键），所以基线必须按合并后本地的真实 hash 算，
    // 不能按远端过滤值算——否则 3 秒防抖一到就把合并态（含本地残留键）
    // 重新上传，云端还原点被污染。合并语义本身在手动下载确认文案里
    // 已如实说明。
    webDAVLog.info('[Sync] 下载设置（远端更新）')
    const filtered = filterSensitiveSettingsForSync(remoteData.data, includeCookies)
    updateSetting(filtered)
    const mergedHash = hashSettingsForSync(filterSensitiveSettingsForSync(settingState.setting, includeCookies) as Record<string, unknown>)
    updateSetting({
      'sync.webdav.lastSyncTimeSettings': remoteTimestamp,
      'sync.webdav.lastSyncSettingsHash': mergedHash,
    })
  } else if (lastHash !== localHash) {
    // 本地有变化：上传，时间戳单调递增，防时钟回拨导致下轮被旧文件滚回
    webDAVLog.info('[Sync] 上传设置（本地有变化）')
    const ts = await uploadSettings(settings, monotonicTimestamp(remoteTimestamp))
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

  // 2026-10-24：同设置——裸 JSON.parse 改走安全解析，见 syncSettingsAuto。
  const remoteData = safeParseSyncFile(remoteContent, '自定义音源', false)
  if (remoteData === null) return
  const remoteTimestamp = remoteData.lastModified ?? 0

  // 全量修复：同设置——无基线且远端无时间戳时跳过，不用本地覆盖云端。
  if (lastHash === '' && !(remoteTimestamp > 0)) {
    webDAVLog.warn('[Sync] 首次同步且云端自定义音源文件无时间戳，无法判断新旧，跳过自动同步', { remoteTimestamp })
    if (!userApisConflictNotified) {
      userApisConflictNotified = true
      toast('首次同步：云端已有自定义音源文件但无时间戳，已跳过自动同步，请在同步页手动选择上传或下载', 'long')
    }
    return
  }

  // 2026-10-24 冲突卡死修复：同设置——无基线不算冲突，见 syncSettingsAuto。
  const hasUserApisBaseline = lastHash !== ''
  if (remoteTimestamp > localTimestamp && hasUserApisBaseline && lastHash !== localHash) {
    // 中：同设置——双端都改时跳过本轮，不再静默以远端覆盖本地脚本
    webDAVLog.warn('[Sync] 自定义音源在本地与云端都有修改，跳过本轮自动同步以防丢数据')
    if (!userApisConflictNotified) {
      userApisConflictNotified = true
      toast('自定义音源在本地与另一台设备都有修改，已跳过自动覆盖，请手动同步确认', 'long')
    }
    return
  }

  if (remoteTimestamp > localTimestamp) {
    webDAVLog.info('[Sync] 下载自定义音源（远端更新）')
    await overwriteUserApis(remoteData.data)
    updateSetting({
      'sync.webdav.lastSyncTimeUserApis': remoteTimestamp,
      'sync.webdav.lastSyncUserApisHash': JSON.stringify(remoteData.data),
    })
  } else if (lastHash !== localHash) {
    webDAVLog.info('[Sync] 上传自定义音源（本地有变化）')
    const ts = await uploadUserApis(userApis, monotonicTimestamp(remoteTimestamp))
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
        // P1（2026-10-12）：filePath 是本机绝对路径，同步时已剥离。
        // 有本地对应任务时必须保留本地的，否则本地已下载文件变"找不到"。
        filePath: localTask.filePath,
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
  // P2-4（2026-10-06）：先比长度，长度不等直接返回 true，避免对 5000 条历史
  // 做两次全量 JSON.stringify（性能优化）
  if (localHistory.length !== remoteHistory.length) return true
  if (localDownloads.length !== remoteDownloads.length) return true
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
    // 2026-10-24：此前 `error.stack ?? error.message` 在 webdav 错误
    // 只有 status/code 时会打出 "Failed: undefined"，甚至空日志。
    webDAVLog.error(`[${label}] Failed: ${describeWebDAVError(error)}`)
    // S10：原始错误已在上一行进日志，用户看友好映射
    toast(`${label}失败：${friendlyWebDAVError(error)}`, 'long')
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
  // 2026-10-24：分步日志——上传设置/音源失败时旧日志只有一行空 ERROR，
  // 看不出卡在设置还是音源、目标远端路径是哪条。这里每步都记路径，
  // 只记路径不记内容（设置可能含 Cookie）。
  webDAVLog.info('[上传] 开始上传设置/音源', { settingsPath: remoteSettingsPath(), apisPath: remoteUserApisPath() })
  await runGuarded('上传', async() => {
    // 全量修复：基线必须用上传前快照，不能用上传后重读。
    // 此前上传后第三次重读会把上传期间的新变更也标记成已同步，
    // 新变更永不上传，直到再有一次无关变更。上传期间的新变更会
    // 触发 markSettingsChanged，下一轮防抖会带上它，不会丢。
    // 时间戳取单调值，防时钟回拨导致下轮被旧文件滚回。
    const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
    const snapshot = await getAllDataForSync(includeCookies)
    const readRemoteTimestamp = async(path: string): Promise<number> => {
      // 只取时间戳用，不弹损坏提示——远端坏文件本来就要被本次上传覆盖，
      // 在上传前弹“已损坏”会误导用户以为上传失败了。
      try {
        const content = await webdav.downloadFile(path)
        if (!content) return 0
        const data = JSON.parse(content)
        return typeof data?.lastModified === 'number' ? data.lastModified : 0
      } catch {
        return 0
      }
    }
    const remoteSettingsTs = await readRemoteTimestamp(remoteSettingsPath())
    const remoteApisTs = await readRemoteTimestamp(remoteUserApisPath())
    onProgress?.(0.1, '正在上传设置…')
    const settingsTs = await uploadSettings(snapshot.settings, monotonicTimestamp(remoteSettingsTs))
    webDAVLog.info('[上传] 设置上传完成', { settingsPath: remoteSettingsPath() })
    onProgress?.(0.5, '正在上传自定义音源…')
    const apisTs = await uploadUserApis(snapshot.userApis, monotonicTimestamp(remoteApisTs))
    webDAVLog.info('[上传] 自定义音源上传完成', { apisPath: remoteUserApisPath() })
    updateSetting({
      'sync.webdav.lastSyncTimeSettings': settingsTs,
      // 低-4：必须用 hashSettingsForSync 的过滤口径（剔除 lastSync* 元数据键），
      // 存原始 JSON.stringify 会让下次自动同步 hash 永不对齐、多传一次
      'sync.webdav.lastSyncSettingsHash': hashSettingsForSync(snapshot.settings as Record<string, unknown>),
      'sync.webdav.lastSyncTimeUserApis': apisTs,
      'sync.webdav.lastSyncUserApisHash': JSON.stringify(snapshot.userApis),
    })
    onProgress?.(1, '上传完成')
    toast('上传成功！')
  })
}

export async function manualDownloadSettingsAndApis(onProgress?: SyncProgressCallback): Promise<boolean> {
  if (!checkSyncReady()) return false
  const confirm = await confirmDialog({
    title: '确认下载',
    message: '这将用云端数据覆盖本地：自定义音源完全覆盖，设置是合并（云端没有的本地设置键会保留）。此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return false

  toast('开始下载...')
  // 2026-10-24：返回是否真正落了本地数据——云端文件损坏/缺失时
  // 只跳过，不算成功，调用方（同步页重启弹窗）据此决定是否提示重启。
  // 全量修复：部分成功时也要返回 true——设置已落盘就需要重启提示，
  // 此前 ok && applied 会把“设置已变、音源失败”吞成“什么都没变”。
  let applied = false
  await runGuarded('下载', async() => {
    onProgress?.(0.1, '正在下载设置…')
    const remoteSettingsContent = await webdav.downloadFile(remoteSettingsPath())
    if (remoteSettingsContent !== null) {
      const remoteSettingsData = safeParseSyncFile(remoteSettingsContent, '设置')
      // 存疑修复：设置文件损坏时只跳过设置、继续下音源——此前 return false
      // 中断整个手动下载，音源永远下不下来且用户看不出原因
      // 空文件（''）也会走到解析失败、按损坏处理，不再误报“未找到”。
      if (!remoteSettingsData) toast('云端设置文件已损坏，已跳过设置下载', 'long')
      else if (!remoteSettingsData.data || typeof remoteSettingsData.data !== 'object' || Array.isArray(remoteSettingsData.data)) toast('云端设置文件结构损坏，已跳过设置下载', 'long')
      else {
        // sync.webdav.syncCookies 开启时，下载设置包含平台 cookie
        const includeCookies = settingState.setting['sync.webdav.syncCookies'] === true
        const filtered = filterSensitiveSettingsForSync(remoteSettingsData.data, includeCookies)
        updateSetting(filtered)
        // 2026-10-24 冲突卡死修复 + 全量修复：基线按合并后本地真实
        // hash 算，不能按远端过滤值算，否则 3 秒后防抖会把合并态
        // 重新上传，云端还原点被污染。
        const mergedHash = hashSettingsForSync(filterSensitiveSettingsForSync(settingState.setting, includeCookies) as Record<string, unknown>)
        updateSetting({
          'sync.webdav.lastSyncTimeSettings': remoteSettingsData.lastModified ?? 0,
          'sync.webdav.lastSyncSettingsHash': mergedHash,
        })
        applied = true
      }
    } else {
      toast('云端未找到设置文件，跳过设置同步')
    }

    onProgress?.(0.5, '正在下载自定义音源…')
    const remoteUserApisContent = await webdav.downloadFile(remoteUserApisPath())
    if (remoteUserApisContent !== null) {
      const remoteApisData = safeParseSyncFile(remoteUserApisContent, '自定义音源')
      if (!remoteApisData) toast('云端自定义音源文件已损坏，已跳过', 'long')
      else {
        await overwriteUserApis(remoteApisData.data)
        // 2026-10-24 冲突卡死修复：同设置——手动下载后推进基线，口径与
        // 自动下载分支一致。overwriteUserApis 抛错时不执行，基线不动。
        updateSetting({
          'sync.webdav.lastSyncTimeUserApis': remoteApisData.lastModified ?? 0,
          'sync.webdav.lastSyncUserApisHash': JSON.stringify(remoteApisData.data),
        })
        applied = true
      }
    } else {
      toast('云端未找到自定义音源文件，跳过音源同步')
    }
    onProgress?.(1, '下载完成')

    // 全量修复：两类都缺失/损坏时不再 toast“下载同步完成”——
    // 此前什么都没落盘也报完成，重启提示又被 ok && applied 吞掉，
    // 用户看到的完成和实际落盘完全对不上。
    if (applied) toast('下载同步完成！')
    else toast('云端文件缺失或损坏，未下载到数据', 'long')
  })
  return applied
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
    const opsAtStart = getOperationQueue()
    const { lists } = await getAllDataForSync()
    onProgress?.(0.4, '正在上传歌单…')
    await uploadLists(lists)
    onProgress?.(0.8, '正在清理同步队列…')
    // 高：只清快照内的操作——上传期间的新编辑不在快照里，必须保留
    await clearOperationQueueSnapshot(opsAtStart)
    onProgress?.(1, '上传完成')
    toast('歌单上传成功！')
  })
}

export async function manualDownloadLists(onProgress?: SyncProgressCallback): Promise<boolean> {
  if (!checkSyncReady()) return false
  const confirm = await confirmDialog({
    title: '确认下载歌单',
    message: '这将使用云端的“所有歌单”完全覆盖本地的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return false

  toast('开始下载歌单...')
  // 2026-10-24：同设置下载——返回是否真正落盘，供同步页重启弹窗判断。
  let applied = false
  const ok = await runGuarded('下载', async() => {
    const opsAtStart = getOperationQueue()
    onProgress?.(0.1, '正在下载歌单…')
    const remoteListsContent = await webdav.downloadFile(remoteListsPath())
    // 全量修复：空文件按损坏处理，不再误报“未找到”。
    if (remoteListsContent !== null) {
      onProgress?.(0.4, '正在解析歌单数据…')
      const remoteData = safeParseSyncFile(remoteListsContent, '歌单')
      if (!remoteData) return false
      const normalizedData = normalizeRemoteListsData(remoteData)
      if (!isValidListsData(normalizedData.data)) {
        toast('云端歌单文件结构损坏，下载已取消', 'long')
        return false
      }
      onProgress?.(0.6, '正在覆盖本地歌单…')
      await overwriteListFull(normalizedData.data)
      applied = true
      await applyRemoteExtraData(normalizedData)
      // 高：快照清——下载期间的新编辑操作要保留待下轮同步
      await clearOperationQueueSnapshot(opsAtStart)
      updateSetting({ 'sync.webdav.lastSyncTimeLists': normalizedData.lastModified })
      onProgress?.(1, '下载完成')
      toast('歌单下载同步完成！')
    } else {
      toast('云端未找到歌单文件')
    }
  })
  return ok && applied
}

// ---------------------------------------------------------------------------
// 自动同步：歌单变更后 3 秒触发
// ---------------------------------------------------------------------------

let listsChanged = false
let settingsChanged = false
// 低-3：变更序号——防抖同步的 finally 若无条件清标志，同步进行中产生的新变更
// 会被一起清掉、永不自动上传（歌单有 opQueue 兜底，设置没有）。用序号区分
// 「同步开始后有没有新变更」。
let listsChangeSeq = 0
let settingsChangeSeq = 0

void loadOperationQueue().catch(() => {
  // P2（2026-10-06）：启动加载失败不阻断主流程，已有日志
})

const debouncedSync = debounce(() => {
  if (!settingState.setting['sync.webdav.enable']) return
  // 歌单同步需要 syncLists 开；设置/插件同步有各自独立开关，
  // 即使歌单同步关闭，只要设置/插件同步开也要跑
  const needLists = settingState.setting['sync.webdav.syncLists'] && listsChanged
  const needSettings = settingState.setting['sync.webdav.syncSettings'] !== false && settingsChanged
  const needApis = settingState.setting['sync.webdav.syncUserApis'] !== false && settingsChanged
  if (needLists || needSettings || needApis) {
    const lSeq = listsChangeSeq
    const sSeq = settingsChangeSeq
    void triggerWebDAVSync(false).then(ran => {
      // 全量修复：同步根本没跑（正有手动/自动同步在跑、isSyncing）
      // 时不能清标志——清了这次变更就静默丢失了。没跑成时保留
      // 标志、再调度一次防抖，等上一轮结束后再跑。
      if (!ran) {
        debouncedSync()
        return
      }
      // 同步期间又产生了新变更（序号变了）则保留标志，等下一轮防抖带上
      if (listsChangeSeq === lSeq) listsChanged = false
      if (settingsChangeSeq === sSeq) settingsChanged = false
    }).catch(() => {
      // trigger 内部已 catch 并 toast，这里只防未处理 rejection 刷屏
    })
  }
}, 3000)

export const markListsChanged = (): void => {
  if (!settingState.setting['sync.webdav.enable']) return
  listsChanged = true
  listsChangeSeq++
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
  settingsChangeSeq++
  debouncedSync()
}

// ---------------------------------------------------------------------------
// 主同步流程
// ---------------------------------------------------------------------------

/** 首次同步：云端已有数据，让用户二选一（上传覆盖云端 / 下载覆盖本地） */
async function resolveFirstSync(remoteData: ListsSyncFile): Promise<'done' | 'cancelled'> {
  // 高：入口快照——确认弹窗等待期间的新编辑不属于本次取舍范围，清队列只清快照内
  const opsAtStart = getOperationQueue()
  webDAVLog.info('[Sync] First sync detected with existing remote data. Prompting user.')
  const userChoice = await confirmDialog({
    title: '首次同步确认',
    message: '云端已存在歌单数据。由于这是该设备上首次同步，请选择您的操作：\n\n“下载”：将使用云端数据覆盖本地（推荐用于恢复数据）。\n“上传”：将使用本地数据覆盖云端（请务必确认本地数据是您最终想要的版本）。',
    cancelButtonText: '下载云端并覆盖本地',
    confirmButtonText: '上传本地并覆盖云端',
  })

  if (userChoice === true) {
    webDAVLog.info('[Sync] User chose to upload local state during first sync.')
    // 低：选本地覆盖时也合并播放历史/下载任务——此前整包冲掉云端独有部分
    pendingExtraData = await buildMergedExtraData(remoteData)
    const { lists: currentLocalLists } = await getAllDataForSync()
    await uploadLists(currentLocalLists)
    await clearOperationQueueSnapshot(opsAtStart)
    toast('本地歌单已上传覆盖云端！')
    return 'done'
  }
  if (userChoice === false) {
    webDAVLog.info('[Sync] User chose to download remote state during first sync.')
    await overwriteListFull(remoteData.data)
    await applyRemoteExtraData(remoteData)
    await clearOperationQueueSnapshot(opsAtStart)
    updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteData.lastModified })
    toast('已从云端同步歌单数据到本地！')
    return 'done'
  }
  webDAVLog.info('[Sync] First sync resolution cancelled.')
  return 'cancelled'
}

export async function triggerWebDAVSync(isManual = false): Promise<boolean> {
  if (isSyncing) {
    if (isManual) toast('正在同步中，请稍后...')
    return false
  }
  if (!isSyncConfigured()) {
    if (isManual) toast('请先启用并配置 WebDAV 同步')
    return false
  }

  isSyncing = true
  if (isManual) toast('开始同步歌单...')

  // 存疑处理：先等操作队列加载完成再读队列，避免未就绪误判 hasLocalChanges
  await whenOperationQueueReady()

  // 全量修复：设置/音源自动同步的错误不再内层吞掉。
  // 此前两个 try/catch 只记 warn，外层故障转移看不到错误、不会换
  // 服务器，用户也收不到任何失败提示；歌单分支的错误却会触发转移，
  // 同一轮同步里两类文件容错行为不一致。现在两类都跑完、把第一个
  // 错误抛到外层，由故障转移判断是否值得轮换、由 trigger 的 catch
  // 统一 toast；解析失败等已在内部返回、不抛错的分支不受影响。
  const runSettingsAndApisSync = async() => {
    let firstError: any = null
    try {
      await syncSettingsAuto()
    } catch (error: any) {
      webDAVLog.warn('[Sync] 设置自动同步失败', { error: error?.message ?? error })
      firstError = firstError ?? error
    }
    try {
      await syncUserApisAuto()
    } catch (error: any) {
      webDAVLog.warn('[Sync] 自定义音源自动同步失败', { error: error?.message ?? error })
      firstError = firstError ?? error
    }
    if (firstError) throw firstError
  }

  try {
    await runWithWebDAVFailover(async() => {
      // P1-7（2026-10-06）：歌单同步受 sync.webdav.syncLists 开关控制。
      // 自动触发时若开关关闭，跳过歌单流程（只跑设置/插件自动同步）；
      // 手动触发（isManual）时允许，方便用户手动同步一次。
      // 注意 syncLists 默认 false，老用户 undefined 按关闭处理（与 UI 一致）。
      if (settingState.setting['sync.webdav.syncLists'] || isManual) {
      const remoteListsContent = await webdav.downloadFile(remoteListsPath())

      // 云端没有歌单文件：直接上传本地
      if (remoteListsContent === null) {
        webDAVLog.info('[Sync] Remote lists not found. Uploading local state.')
        const opsAtStart = getOperationQueue()
        const { lists } = await getAllDataForSync()
        await uploadLists(lists)
        await clearOperationQueueSnapshot(opsAtStart)
        if (isManual) toast('歌单上传成功！')
        await runSettingsAndApisSync()
        return
      }

      const parsedLists = safeParseSyncFile(remoteListsContent, '歌单')
      if (parsedLists && !isValidListsData(normalizeRemoteListsData(parsedLists).data)) {
        // 中：结构损坏（缺核心歌单数组）——跳过歌单同步，不清队列不推进时间戳
        webDAVLog.error('[Sync] 云端歌单文件结构损坏（缺 defaultList/loveList/userList），跳过歌单同步')
        toast('云端歌单文件结构损坏，歌单同步已跳过', 'long')
      } else if (parsedLists) {
        const remoteData = normalizeRemoteListsData(parsedLists)
        const remoteTimestamp = remoteData.lastModified
        const localTimestamp = settingState.setting['sync.webdav.lastSyncTimeLists'] ?? 0

        // 首次同步（本地无时间戳但云端有数据）
        if (localTimestamp === 0) {
          const result = await resolveFirstSync(remoteData)
          if (result === 'cancelled' && isManual) toast('同步已取消')
          await runSettingsAndApisSync()
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
              const opsAtChoice = getOperationQueue()
              // 低：强制本地覆盖时也合并播放历史/下载任务，不整包冲掉云端独有部分
              pendingExtraData = await buildMergedExtraData(remoteData)
              const { lists: currentLocalLists } = await getAllDataForSync()
              await uploadLists(currentLocalLists)
              await clearOperationQueueSnapshot(opsAtChoice)
              toast('已强制使用本地歌单覆盖云端！')
            } else if (userChoice === false) {
              webDAVLog.info('[Sync] Conflict resolved by user: Force pulling remote state.')
              const opsAtChoice = getOperationQueue()
              await overwriteListFull(remoteData.data)
              await applyRemoteExtraData(remoteData)
              await clearOperationQueueSnapshot(opsAtChoice)
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
            // 高：只清被重放的 localOpQueue——同步期间新入队的操作保留
            await clearOperationQueueSnapshot(localOpQueue)
          }
        } else if (hasLocalChanges) {
          webDAVLog.info('[Sync] Local has unsynced changes. Uploading.')
          const opsAtStart = getOperationQueue()
          const { lists: currentLocalLists } = await getAllDataForSync()
          await uploadLists(currentLocalLists)
          await clearOperationQueueSnapshot(opsAtStart)
          if (isManual) toast('本地歌单已上传！')
        } else if (isManual) {
          webDAVLog.info('[Sync] Lists are up to date.')
          toast('歌单已是最新，无需同步')
        }
      }
      } // P1-7: syncLists 开关 guard 结束

      // 自动同步设置与自定义音源（2026-10-06）：歌单同步完成后顺带执行，
      // 各自有独立开关 sync.webdav.syncSettings / sync.webdav.syncUserApis，
      // 内部用 hash 防重复上传、用时间戳做 last-write-wins。
      // 注意：放在 failover 回调内，享受多服务器故障转移。
      await runSettingsAndApisSync()
    })
  } catch (error: any) {
    webDAVLog.error(`[Sync] Sync failed: ${describeWebDAVError(error)}`)
    // P2（2026-10-06）：error.message 可能为 undefined，避免 toast 显示"同步失败: undefined"
    toast(`同步失败：${friendlyWebDAVError(error)}`, 'long')
  } finally {
    isSyncing = false
  }
  return true
}
