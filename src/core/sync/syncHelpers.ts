import { getListMusics } from '@/core/list'
import listState from '@/store/list/state'
import settingState from '@/store/setting/state'
import { LIST_IDS } from '@/config/constant'
import { getPlayHistory, getUserApiList, getUserApiScript } from '@/utils/data.ts'
import { normalizeDownloadTasksForSync } from '@/utils/data/download'
import downloadState from '@/store/download/state'

const SENSITIVE_SETTING_KEYS: Array<keyof LX.AppSetting> = [
  'common.wy_cookie',
  'common.wy_serpapi_key',
  'common.yt_cookie',
  'common.tx_cookie',
  'common.kg_cookie',
  'sync.webdav.password',
]

/** 平台 cookie 键（2026-10-04）：sync.webdav.syncCookies 开启时参与同步。
 * 注：yt_cookie 可能是 SerpAPI 相关，保留同步。 */
export const COOKIE_SETTING_KEYS: Array<keyof LX.AppSetting> = [
  'common.wy_cookie',
  'common.yt_cookie',
  'common.tx_cookie',
  'common.kg_cookie',
]

export const filterSensitiveSettingsForSync = (settings: Partial<LX.AppSetting>, includeCookies = false) => {
  const nextSettings = { ...settings }
  const keysToRemove = includeCookies
    ? SENSITIVE_SETTING_KEYS.filter(k => !COOKIE_SETTING_KEYS.includes(k))
    : SENSITIVE_SETTING_KEYS
  for (const key of keysToRemove) {
    delete nextSettings[key]
  }
  return nextSettings
}

export const getAllDataForSync = async(includeCookies = false) => {
  const defaultList = await getListMusics(listState.defaultList.id)
  const loveList = await getListMusics(listState.loveList.id)
  const tempList = await getListMusics(LIST_IDS.TEMP)
  const userList = []
  for await (const list of listState.userList) {
    userList.push({ ...list, list: await getListMusics(list.id) })
  }
  const lists = { defaultList, loveList, userList, tempList }
  const playHistory = await getPlayHistory()
  const downloadTasks = normalizeDownloadTasksForSync(downloadState.tasks)
  const settings = filterSensitiveSettingsForSync(settingState.setting, includeCookies)

  const userApiList = await getUserApiList()
  const userApiScripts: Record<string, string> = {}
  for (const api of userApiList) {
    userApiScripts[api.id] = await getUserApiScript(api.id)
  }
  const userApis = {
    list: userApiList,
    scripts: userApiScripts,
  }

  return { lists, playHistory, downloadTasks, settings, userApis }
}
