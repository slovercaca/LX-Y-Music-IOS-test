import { LIST_IDS } from '@/config/constant'
import defaultSetting from '@/config/defaultSetting'
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
  if (!isObject(data) || Array.isArray(data)) throw new Error('invalid backup data')
  // 低：空 data（{}/缺字段）此前全过校验、弹「导入成功」却什么都没恢复，
  // 还掩盖真损坏——至少要含一个已知字段
  if (data.lists === undefined && data.playHistory === undefined && data.downloadTasks === undefined
    && data.settings === undefined && data.userApis === undefined) {
    throw new Error('empty backup data')
  }
  if (data.lists !== undefined) {
    const lists = data.lists as any
    if (!isObject(lists)
      || !Array.isArray(lists.defaultList)
      || !Array.isArray(lists.loveList)
      || !Array.isArray(lists.userList)) {
      throw new Error('invalid backup lists')
    }
    // 中：逐项查结构——残缺 userList（缺 id/list）此前能过校验，
    // overwriteListFull 把 undefined 写进歌曲表、导入「成功」后开歌单崩溃
    for (const song of [...lists.defaultList, ...lists.loveList]) {
      if (!isObject(song)) throw new Error('invalid backup list item')
    }
    for (const userList of lists.userList) {
      if (!isObject(userList) || typeof userList.id !== 'string' || !Array.isArray(userList.list)) {
        throw new Error('invalid backup userList item')
      }
      for (const song of userList.list) {
        if (!isObject(song)) throw new Error('invalid backup userList song')
      }
    }
  }
  if (data.playHistory !== undefined && !Array.isArray(data.playHistory)) throw new Error('invalid backup playHistory')
  if (data.downloadTasks !== undefined && !Array.isArray(data.downloadTasks)) throw new Error('invalid backup downloadTasks')
  if (data.settings !== undefined) {
    // 中：isObject 对数组也为 true，且不查值类型——错误类型会被合并落盘
    // 持久化（如 theme.blur 写成字符串，消费方算出 NaN 且重启仍在）
    if (!isObject(data.settings) || Array.isArray(data.settings)) throw new Error('invalid backup settings')
    for (const [key, value] of Object.entries(data.settings as Record<string, any>)) {
      const def = (defaultSetting as Record<string, any>)[key]
      if (def !== undefined && def !== null && value !== null && typeof value !== typeof def) {
        throw new Error(`invalid backup setting type: ${key}`)
      }
    }
  }
  if (data.userApis !== undefined) {
    const apis = data.userApis as any
    // 高：scripts 必须存在且为「id→脚本字符串」对象——缺失时放行会在
    // overwriteUserApis 里静默清空全部自定义音源脚本且不可回滚
    if (!isObject(apis) || !Array.isArray(apis.list) || !isObject(apis.scripts) || Array.isArray(apis.scripts)
      || !Object.values(apis.scripts).every(v => typeof v === 'string')) {
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

    // S9：成功提示合并成一条（此前「需要重启」会被随后的「导入成功」顶掉看不见），
    // 并返回 true 让外层不再重复弹成功提示
    toast('导入成功，部分设置需要重启后生效', 'long')
    return true
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
  let failedCount = 0
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
      // 中：此前逐单吞错后照样报「导入成功」——收集失败数，有任一失败
      // 即中止整包导入（已有数据不动），让外层如实提示失败
      failedCount++
      console.log(err)
    }
  }
  if (failedCount > 0) throw new Error(`${failedCount} 个歌单导入失败`)
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
  let failedCount = 0
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
      failedCount++
      console.log(err)
    }
  }
  if (failedCount > 0) throw new Error(`${failedCount} 个歌单导入失败`)
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
      destructive: true,
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
    // S2：此前点「不要啊」会改个 ID 照样导入，用户以为取消了其实多出一个重复歌单。
    // 现在第二步明确问是否另存，都不要才真的取消导入。
    const saveAsNew = await confirmDialog({
      message: '没有覆盖本地列表。要把导入的列表另存为一个新歌单吗？',
      cancelButtonText: '取消导入',
      confirmButtonText: '另存为新歌单',
      bgClose: false,
    })
    if (!saveAsNew) {
      toast('已取消导入')
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
      // 中：必须 return true——此前返回 undefined，外层把 falsy 的 skipTip
      // 当成功，又弹一条「导入成功」，失败说明与成功提示同屏矛盾
      return true
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
      // S10：原始错误只进日志，用户看可行动的中文提示
      log.error(err.message)
      toast(global.i18n.t('setting_backup_part_export_list_tip_failed') + '，请确认存储空间充足后重试')
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
