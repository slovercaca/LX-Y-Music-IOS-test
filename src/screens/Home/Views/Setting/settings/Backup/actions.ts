import { LIST_IDS } from '@/config/constant'
import {
  createList,
  getListMusics,
  overwriteList,
  overwriteListFull,
  overwriteListMusics,
} from '@/core/list'
import { updateSetting } from '@/core/common'
import { filterSensitiveSettingsForSync, getAllDataForSync } from '@/core/sync/syncHelpers'
import { overwriteUserApis } from '@/core/userApi'
import { filterMusicList, fixNewMusicInfoQuality, toNewMusicInfo } from '@/utils'
import { savePlayHistory, getPlayHistory } from '@/utils/data'
import { normalizeRemoteSyncedDownloadTasks, saveDownloadTasks } from '@/utils/data/download'
import { log } from '@/utils/log'
import { confirmDialog, handleReadFile, handleSaveFile, showImportTip, toast } from '@/utils/tools'
import listState from '@/store/list/state'
import downloadState from '@/store/download/state'
import settingState from '@/store/setting/state'

const isObject = (v: any): v is Record<string, any> => typeof v == 'object' && v !== null

/**
 * P0 修复：导入前预校验。坏包（字段缺失/类型不对）在动任何数据之前就拒绝，
 * 避免 overwriteListFull 先把歌单清掉、后面步骤才抛错的半吊子状态。
 */
const validateBackupData = (data: LX.ConfigFile.AllDataV3['data']) => {
  if (!isObject(data)) throw new Error('invalid backup data')
  if (data.lists !== undefined) {
    const lists = data.lists as any
    if (!isObject(lists)
      || !Array.isArray(lists.defaultList)
      || !Array.isArray(lists.loveList)
      || !Array.isArray(lists.userList)) {
      throw new Error('invalid backup lists')
    }
  }
  if (data.playHistory !== undefined && !Array.isArray(data.playHistory)) throw new Error('invalid backup playHistory')
  if (data.downloadTasks !== undefined && !Array.isArray(data.downloadTasks)) throw new Error('invalid backup downloadTasks')
  if (data.settings !== undefined && !isObject(data.settings)) throw new Error('invalid backup settings')
  if (data.userApis !== undefined) {
    const apis = data.userApis as any
    if (!isObject(apis) || !Array.isArray(apis.list) || (apis.scripts !== undefined && !isObject(apis.scripts))) {
      throw new Error('invalid backup userApis')
    }
  }
}

interface BackupSnapshot {
  lists: { defaultList: LX.Music.MusicInfo[], loveList: LX.Music.MusicInfo[], userList: LX.List.UserListInfoFull[] }
  playHistory: LX.Player.PlayHistoryItem[]
  downloadTasks: LX.Download.DownloadTask[]
  settings: LX.AppSetting
}
const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** 导入前对会被覆盖的四类数据做快照（均为 JSON 可序列化的纯数据） */
const snapshotBackupTargets = async(): Promise<BackupSnapshot> => {
  const all = await getAllLists()
  const [defaultList, loveList, ...userList] = all
  return {
    lists: deepCopy({
      defaultList: defaultList.list,
      loveList: loveList.list,
      userList: userList as LX.List.UserListInfoFull[],
    }),
    playHistory: deepCopy(await getPlayHistory()),
    downloadTasks: deepCopy(downloadState.tasks),
    settings: deepCopy(settingState.setting),
  }
}

/**
 * 最佳努力回滚：每一步独立 try/catch，某步回滚失败不掩盖原始错误，
 * 返回成功恢复的域名，用于如实告诉用户。
 * 注意：自定义 API 脚本（userApis）散落在多个存储 key，回滚它需要复制
 * userApi 模块的内部存储约定，耦合风险高，故不纳入；失败提示里会明确说明。
 */
const restoreBackupSnapshot = async(snapshot: BackupSnapshot): Promise<string[]> => {
  const restored: string[] = []
  try {
    await overwriteListFull(snapshot.lists)
    restored.push('歌单')
  } catch (err) { log.error('rollback lists failed', err) }
  try {
    await savePlayHistory(snapshot.playHistory)
    global.app_event.playHistoryUpdated()
    restored.push('播放历史')
  } catch (err) { log.error('rollback playHistory failed', err) }
  try {
    downloadState.tasks = snapshot.downloadTasks
    await saveDownloadTasks(snapshot.downloadTasks)
    global.app_event.download_list_changed()
    restored.push('下载任务')
  } catch (err) { log.error('rollback downloadTasks failed', err) }
  try {
    updateSetting(snapshot.settings)
    restored.push('设置')
  } catch (err) { log.error('rollback settings failed', err) }
  return restored
}

const importBackupData = async(data: LX.ConfigFile.AllDataV3['data']) => {
  if (!(await showConfirm())) return true

  // 先校验，再快照，最后才动数据
  try {
    validateBackupData(data)
  } catch (err: any) {
    log.error('backup data invalid:', err?.message)
    toast('备份文件损坏或格式不正确，已取消导入')
    return true
  }
  const snapshot = await snapshotBackupTargets()

  try {
    if (data.lists) await overwriteListFull(data.lists)

    if (Array.isArray(data.playHistory)) {
      await savePlayHistory(data.playHistory)
      global.app_event.playHistoryUpdated()
    }

    if (Array.isArray(data.downloadTasks)) {
      const tasks = normalizeRemoteSyncedDownloadTasks(data.downloadTasks)
      downloadState.tasks = tasks
      await saveDownloadTasks(tasks)
      global.app_event.download_list_changed()
    }

    if (data.settings) updateSetting(filterSensitiveSettingsForSync(data.settings))

    if (data.userApis) await overwriteUserApis(data.userApis)

    toast('部分设置需要重启后生效')
  } catch (err: any) {
    log.error('import backup data failed:', err?.stack ?? err)
    const restored = await restoreBackupSnapshot(snapshot)
    toast(
      restored.length
        ? `备份导入失败，已恢复${restored.join('、')}到导入前状态；自定义 API 脚本如有异常请重新导入`
        : '备份导入失败，且自动恢复也失败了，请检查歌单数据是否完整',
      'long',
    )
    return true
  }
}
const getAllLists = async() => {
  const lists = []
  lists.push(
    await getListMusics(listState.defaultList.id).then((musics) => ({
      ...listState.defaultList,
      list: musics,
    })),
  )
  lists.push(
    await getListMusics(listState.loveList.id).then((musics) => ({
      ...listState.loveList,
      list: musics,
    })),
  )

  for await (const list of listState.userList) {
    lists.push(await getListMusics(list.id).then((musics) => ({ ...list, list: musics })))
  }

  return lists
}
const importOldListData = async(lists: any[]) => {
  const allLists = await getAllLists()
  for (const list of lists) {
    try {
      const targetList = allLists.find((l) => l.id == list.id)
      if (targetList) {
        targetList.list = filterMusicList((list.list as any[]).map((m) => toNewMusicInfo(m)) as LX.Music.MusicInfo[])
      } else {
        const listInfo = {
          name: list.name,
          id: list.id,
          list: filterMusicList((list.list as any[]).map((m) => toNewMusicInfo(m)) as LX.Music.MusicInfo[]),
          source: list.source,
          sourceListId: list.sourceListId,
          locationUpdateTime: list.locationUpdateTime ?? null,
        }
        allLists.push(listInfo as LX.List.UserListInfoFull)
      }
    } catch (err) {
      console.log(err)
    }
  }
  const defaultList = allLists.shift()!.list
  const loveList = allLists.shift()!.list
  await overwriteListFull({
    defaultList,
    loveList,
    userList: allLists as LX.List.UserListInfoFull[],
  })
}
const importNewListData = async(
  lists: Array<
  LX.List.MyDefaultListInfoFull | LX.List.MyLoveListInfoFull | LX.List.UserListInfoFull
  >,
) => {
  const allLists = await getAllLists()
  for (const list of lists) {
    try {
      const targetList = allLists.find((l) => l.id == list.id)
      if (targetList) {
        targetList.list = filterMusicList(list.list).map((m) => fixNewMusicInfoQuality(m))
      } else {
        const data = {
          name: list.name,
          id: list.id,
          list: filterMusicList(list.list).map((m) => fixNewMusicInfoQuality(m)),
          source: (list as LX.List.UserListInfoFull).source,
          sourceListId: (list as LX.List.UserListInfoFull).sourceListId,
          locationUpdateTime: (list as LX.List.UserListInfoFull).locationUpdateTime ?? null,
        }
        allLists.push(data as LX.List.UserListInfoFull)
      }
    } catch (err) {
      console.log(err)
    }
  }
  const defaultList = allLists.shift()!.list
  const loveList = allLists.shift()!.list
  await overwriteListFull({
    defaultList,
    loveList,
    userList: allLists as LX.List.UserListInfoFull[],
  })
}

/**
 * Import a single list
 * @param listData
 * @param position
 * @returns
 */
export const handleImportListPart = async(
  listData: LX.ConfigFile.MyListInfoPart['data'],
  position: number = listState.userList.length,
) => {
  const targetList = listState.allList.find((l) => l.id === listData.id)
  if (targetList) {
    const confirm = await confirmDialog({
      message: global.i18n.t('list_import_part_confirm', {
        importName: listData.name,
        localName: targetList.name,
      }),
      cancelButtonText: global.i18n.t('list_import_part_button_cancel'),
      confirmButtonText: global.i18n.t('list_import_part_button_confirm'),
      bgClose: false,
    })
    if (confirm) {
      listData.name = targetList.name
      void overwriteList(listData)
        .then(() => {
          toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
        })
        .catch((err) => {
          log.error(err)
          toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
        })
      return
    }
    listData.id += `__${Date.now()}`
  }
  const userList = listData as LX.List.UserListInfoFull
  void createList({
    name: userList.name,
    id: userList.id,
    list: userList.list,
    source: userList.source,
    sourceListId: userList.sourceListId,
    position: Math.max(position, -1),
  })
    .then(() => {
      toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
    })
    .catch((err) => {
      log.error(err)
      toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
    })
}

const showConfirm = async() => {
  return confirmDialog({
    message: global.i18n.t('list_import_part_confirm_tip'),
    cancelButtonText: global.i18n.t('dialog_cancel'),
    confirmButtonText: global.i18n.t('confirm_button_text'),
    bgClose: false,
  })
}

const importPlayList = async(path: string) => {
  let configData: any
  try {
    configData = await handleReadFile(path)
  } catch (error: any) {
    log.error(error.stack)
    throw error
  }

  switch (configData.type) {
    case 'defautlList':
      if (!(await showConfirm())) return true
      await overwriteListMusics(
        LIST_IDS.DEFAULT,
        filterMusicList(
          (configData.data as LX.List.MyDefaultListInfoFull).list.map((m) => toNewMusicInfo(m)) as LX.Music.MusicInfo[],
        ),
      )
      break
    case 'playList':
      if (!(await showConfirm())) return true
      await importOldListData(configData.data)
      break
    case 'playList_v2':
      if (!(await showConfirm())) return true
      await importNewListData(configData.data)
      break
    case 'allData':
      if (!(await showConfirm())) return true
      if (configData.defaultList) {
        await overwriteListMusics(
          LIST_IDS.DEFAULT,
          filterMusicList(
            (configData.defaultList as LX.List.MyDefaultListInfoFull).list.map((m) =>
              toNewMusicInfo(m),
            ) as LX.Music.MusicInfo[],
          ),
        )
      } else await importOldListData(configData.playList)
      break
    case 'allData_v2':
      if (!(await showConfirm())) return true
      await importNewListData(configData.playList)
      break
    case 'allData_v3':
      return importBackupData(configData.data as LX.ConfigFile.AllDataV3['data'])
    case 'playListPart':
      configData.data.list = filterMusicList(
        (configData.data as LX.ConfigFile.MyListInfoPart['data']).list.map((m) => toNewMusicInfo(m)) as LX.Music.MusicInfo[],
      )

      void handleImportListPart(configData.data)
      return true
    case 'playListPart_v2':
      configData.data.list = filterMusicList(
        (configData.data as LX.ConfigFile.MyListInfoPart['data']).list,
      ).map((m) => fixNewMusicInfoQuality(m))

      void handleImportListPart(configData.data)
      return true

    default:
      showImportTip(configData.type)
  }
}

export const handleImportList = (path: string) => {
  console.log(path)
  toast(global.i18n.t('setting_backup_part_import_list_tip_unzip'))
  void importPlayList(path)
    .then((skipTip) => {
      if (skipTip) return
      toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
    })
    .catch((err) => {
      log.error(err)
      toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
    })
}

const exportAllList = async(path: string) => {
  const data: LX.ConfigFile.AllDataV3 = JSON.parse(
    JSON.stringify({
      type: 'allData_v3',
      data: await getAllDataForSync(),
    }),
  )

  try {
    await handleSaveFile(path + '/lx_backup.lxmc', data)
  } catch (error: any) {
    log.error(error.stack)
    throw error
  }
}
export const handleExportList = (path: string) => {
  toast(global.i18n.t('setting_backup_part_export_list_tip_zip'))
  void exportAllList(path)
    .then(() => {
      toast(global.i18n.t('setting_backup_part_export_list_tip_success'))
    })
    .catch((err: any) => {
      log.error(err.message)
      toast(
        global.i18n.t('setting_backup_part_export_list_tip_failed') + ': ' + (err.message as string),
      )
    })
}

// iOS 导出：写入指定文件（供系统分享面板使用）
export const handleExportListToFile = async(filePath: string) => {
  const data: LX.ConfigFile.AllDataV3 = JSON.parse(
    JSON.stringify({
      type: 'allData_v3',
      data: await getAllDataForSync(),
    }),
  )

  try {
    await handleSaveFile(filePath, data)
  } catch (error: any) {
    log.error(error.stack)
    throw error
  }
}
