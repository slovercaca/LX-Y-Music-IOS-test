import { action, state } from '@/store/userApi'
import {
  addUserApi,
  getUserApiScript,
  removeUserApi as removeUserApiFromStore,
  setUserApiAllowShowUpdateAlert as setUserApiAllowShowUpdateAlertFromStore,
  setUserApiList as setUserApiListFromStore,
} from '@/utils/data'
import { destroy, loadScript } from '@/utils/nativeModules/userApi'
import { log as writeLog } from '@/utils/log'
import { getAllKeys, removeDataMultiple, saveDataMultiple } from '@/plugins/storage.ts'
import { storageDataPrefix } from '@/config/constant.ts'

export const setUserApi = async(apiId: string) => {
  global.lx.qualityList = {}
  setUserApiStatus(false, 'initing')

  const target = state.list.find((api) => api.id === apiId)
  if (!target) throw new Error('api not found')
  const script = await getUserApiScript(target.id)
  loadScript({ ...target, script })
}

export const destroyUserApi = () => {
  destroy()
}

export const setUserApiStatus: (typeof action)['setStatus'] = (status, message) => {
  action.setStatus(status, message)
}

export const setUserApiList: (typeof action)['setUserApiList'] = (list) => {
  action.setUserApiList(list)
}

export const importUserApi = async(script: string) => {
  const info = await addUserApi(script)
  action.addUserApi(info)
}

export const removeUserApi = async(ids: string[]) => {
  const list = await removeUserApiFromStore(ids)
  action.setUserApiList(list)
}

export const setUserApiAllowShowUpdateAlert = async(id: string, enable: boolean) => {
  await setUserApiAllowShowUpdateAlertFromStore(id, enable)
  action.setUserApiAllowShowUpdateAlert(id, enable)
}

export const reorderUserApi = async(list: LX.UserApi.UserApiInfo[]) => {
  const persisted = await setUserApiListFromStore(list)
  action.setUserApiList(persisted)
}

export const overwriteUserApis = async(data: { list: LX.UserApi.UserApiInfo[], scripts: Record<string, string> }) => {
  // 高：scripts 缺失时绝不能继续——下方会以空脚本集为新全集先删本地全部
  // 旧脚本再写入 list，自定义音源只剩名单、脚本全灭且不抛错。备份校验与
  // WebDAV 同步两条路都经过这里，在源头拒绝
  if (!data.scripts || typeof data.scripts !== 'object' || Array.isArray(data.scripts)) {
    throw new Error('userApis scripts missing or invalid')
  }
  // 全量修复：同理，list 缺失/不是数组时绝不能继续——此前会把 list
  // 存成 undefined、本地名单被清空，随后基线还会被写成这份坏数据，
  // 清空状态被锁定并在下次上传时反向写回云端。
  if (!Array.isArray(data.list)) {
    throw new Error('userApis list missing or invalid')
  }
  try {
    const allKeys = await getAllKeys()
    const oldScriptKeys = allKeys.filter(key => key.startsWith(storageDataPrefix.userApi) && key !== storageDataPrefix.userApi)
    const newScriptIds = new Set(Object.keys(data.scripts ?? {}))
    const keysToRemove = oldScriptKeys.filter(key => {
      const scriptId = key.substring(storageDataPrefix.userApi.length)
      return !newScriptIds.has(scriptId)
    })
    if (keysToRemove.length) await removeDataMultiple(keysToRemove)

    const saveTasks: Array<[string, any]> = []
    saveTasks.push([storageDataPrefix.userApi, data.list])
    for (const [id, script] of Object.entries(data.scripts ?? {})) {
      saveTasks.push([`${storageDataPrefix.userApi}${id}`, script])
    }
    await saveDataMultiple(saveTasks)

    action.setUserApiList(data.list)
  } catch (error: any) {
    log.error('Overwrite user apis failed:', error.message)
    throw error
  }
}

export const log = {
  r_info(...params: any[]) {
    if (!global.lx.isEnableLog) return
    writeLog.info(...params)
  },
  r_warn(...params: any[]) {
    if (!global.lx.isEnableLog) return
    writeLog.warn(...params)
  },
  r_error(...params: any[]) {
    if (!global.lx.isEnableLog) return
    writeLog.error(...params)
  },
  log(...params: any[]) {
    if (!global.lx.isEnableLog) return
    if (!global.lx.isEnableUserApiLog) return
    writeLog.info(...params)
  },
  info(...params: any[]) {
    if (!global.lx.isEnableLog) return
    if (!global.lx.isEnableUserApiLog) return
    writeLog.info(...params)
  },
  warn(...params: any[]) {
    if (!global.lx.isEnableLog) return
    if (!global.lx.isEnableUserApiLog) return
    writeLog.warn(...params)
  },
  error(...params: any[]) {
    if (!global.lx.isEnableLog) return
    if (!global.lx.isEnableUserApiLog) return
    writeLog.error(...params)
  },
}
