import { updateSetting as mergeSetting } from '@/config/setting'
import state from './state'
import { storageDataPrefix } from '@/config/constant'
import { saveData } from '@/plugins/storage'

// D-5：三个平台 Cookie 键——重设相同值时也强制广播（见 updateSetting）。
// Cookie 监听（core/init/common.ts 的 handle*CookieUpdate）只看广播键
// 是否存在，重贴同一 Cookie 时 1-16 的无变更短路会让监听收不到重拉信号，
// 失败后无法靠重贴重试。只针对这三个键，不放开其他键。
const COOKIE_KEYS: Array<keyof LX.AppSetting> = ['common.wy_cookie', 'common.tx_cookie', 'common.kg_cookie']

export default {
  initSetting(newSetting: LX.AppSetting) {
    state.setting = newSetting
  },
  updateSetting(newSetting: Partial<LX.AppSetting>) {
    const result = mergeSetting(newSetting)
    // D-5：强制广播键——入参里带了、值与当前相同（未进 updatedSettingKeys）
    // 且非空的 Cookie 键。值本身变了的 Cookie 键已在 updatedSettingKeys
    // 里，不重复算；空值重设（重复清空）无重拉意义，不强制广播。
    const forcedCookieKeys = (Object.keys(newSetting ?? {}) as Array<keyof LX.AppSetting>)
      .filter(k => COOKIE_KEYS.includes(k) && !result.updatedSettingKeys.includes(k) && !!(newSetting as Record<string, unknown>)[k as string])
    // 1-16：无键变更时不广播、不写盘——初始化回写相同值等场景不再造成
    // 无效广播 + 无谓写盘；返回实际变更键供 core/common 判断是否同步
    if (!result.updatedSettingKeys.length && !forcedCookieKeys.length) return result.updatedSettingKeys
    // 广播键 = 实际变更键 + 强制 Cookie 键；广播载荷补上强制键的当前值
    // （Cookie 监听从载荷读值，不读 store；值与当前相同，直接取合并结果）
    const broadcastKeys = [...result.updatedSettingKeys, ...forcedCookieKeys]
    const broadcastSetting: Partial<LX.AppSetting> = { ...result.updatedSetting }
    for (const key of forcedCookieKeys) {
      (broadcastSetting as Record<string, unknown>)[key as string] = result.setting[key]
    }
    state.setting = result.setting
    global.state_event.configUpdated(broadcastKeys, broadcastSetting)
    // 只有真实变更才写盘：重设相同 Cookie 时磁盘值本就相同，不写盘
    if (result.updatedSettingKeys.length) {
      void saveData(storageDataPrefix.setting, state.setting)
    }
    return result.updatedSettingKeys
  },
}
