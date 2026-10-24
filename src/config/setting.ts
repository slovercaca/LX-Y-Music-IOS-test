import { storageDataPrefix, storageDataPrefixOld, NAV_MENUS } from '@/config/constant'
import defaultSetting from '@/config/defaultSetting'
import { getData, removeData, saveData } from '@/plugins/storage'
import migrateSetting from './migrateSetting'
import settingState from '@/store/setting/state'
import { migrateMetaData, migrateListData } from './migrate'
import { exitApp, tipDialog } from '@/utils/tools'

const primitiveType = ['string', 'boolean', 'number']
const checkPrimitiveType = (val: any): boolean => val === null || primitiveType.includes(typeof val)

const arraysEqual = (a: any[], b: any[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const DEEP_KEYS = ['common.navStatus', 'common.navOrder', 'common.sectionExpandedStatus', 'search.enabledSources', 'common.navFlatOrder', 'common.discoveryPlatformOrder', 'list.myListVisibility']

const mergeSetting = (
  originSetting: LX.AppSetting,
  targetSetting?: Partial<LX.AppSetting> | null,
): {
  setting: LX.AppSetting
  updatedSettingKeys: Array<keyof LX.AppSetting>
  updatedSetting: Partial<LX.AppSetting>
} => {
  let originSettingCopy: LX.AppSetting = { ...originSetting }
  const updatedSettingKeys: Array<keyof LX.AppSetting> = []
  const updatedSetting: Partial<LX.AppSetting> = {}

  if (targetSetting) {
    const targetSettingKeys = Object.keys(targetSetting)

    const processKey = (key: keyof LX.AppSetting) => {
      const targetValue: any = targetSetting[key]
      const isPrimitive = checkPrimitiveType(targetValue)
      let shouldSkip = false

      if (!isPrimitive && !DEEP_KEYS.includes(key as string)) {
        shouldSkip = true
      } else if (DEEP_KEYS.includes(key as string)) {
        if (Array.isArray(targetValue) && Array.isArray(originSettingCopy[key])) {
          if (arraysEqual(targetValue, originSettingCopy[key])) shouldSkip = true
        } else if (typeof targetValue === 'object' && typeof originSettingCopy[key] === 'object' && targetValue !== null && originSettingCopy[key] !== null) {
          if (JSON.stringify(targetValue) === JSON.stringify(originSettingCopy[key])) shouldSkip = true
        } else if (targetValue === originSettingCopy[key]) {
          shouldSkip = true
        }
      } else if (targetValue === originSettingCopy[key]) {
        // 低：原为松散 == ——导入把数值写成字符串（"theme.blur":"18"）时
        // 被判「未变更」静默不生效；改严格相等
        shouldSkip = true
      }

      if (!shouldSkip) {
        updatedSettingKeys.push(key)
        // 中：DEEP 对象键逐键合并而非整表替换——老用户持久化的
        // search.enabledSources 缺后加的平台键时，整表替换会让缺键平台
        // 从聚合/歌单搜索静默消失（其他 DEEP 消费方有 ?? true 兜底、它没有）
        const mergedValue = DEEP_KEYS.includes(key as string)
          && !Array.isArray(targetValue)
          && typeof targetValue === 'object' && targetValue !== null
          && typeof originSettingCopy[key] === 'object' && originSettingCopy[key] !== null
          && !Array.isArray(originSettingCopy[key])
          ? { ...(originSettingCopy[key] as Record<string, any>), ...(targetValue as Record<string, any>) }
          : targetValue
        updatedSetting[key] = mergedValue
        originSettingCopy[key] = mergedValue
      }
    }

    // 低：统一遍历目标键——此前按「键数量」选分支：目标键多时合法新键被
    // 静默丢弃、少时未知键又会被写进设置落盘，同份导入数据结果不一致。
    // 现在不在当前默认集内的未知键一律显式丢弃。
    for (const key of targetSettingKeys as Array<keyof LX.AppSetting>) {
      if (!(key in originSettingCopy)) continue
      processKey(key)
    }
  }

  return {
    setting: originSettingCopy,
    updatedSettingKeys,
    updatedSetting,
  }
}
export const updateSetting = (setting?: Partial<LX.AppSetting> | null, isInit: boolean = false) => {
  let originSetting: LX.AppSetting
  if (isInit) {
    originSetting = { ...defaultSetting }
  } else originSetting = settingState.setting

  const result = mergeSetting(originSetting, setting)

  result.setting.version = defaultSetting.version

  return result
}

export const initSetting = async() => {
  let setting: Partial<LX.AppSetting> | null = await getData(storageDataPrefix.setting)

  // try migrate setting before v1
  if (!setting) {
    const config = await getData<{ setting?: any }>(storageDataPrefixOld.setting)
    if (config != null) {
      setting = migrateSetting(config)
      try {
        await migrateListData()
        await migrateMetaData()
      } catch (err: any) {
        void tipDialog({
          title: '数据迁移失败 (Failed to migrate data)',
          message: `请截图并在 GitHub 反馈。为了防止数据丢失，应用将停止运行。错误信息：\n${(err.stack ?? err.message) as string}`,
          btnText: 'Exit',
          bgClose: false,
        }).then(() => {
          exitApp()
        })
        throw err
      }
      await removeData(storageDataPrefixOld.setting)
    }
  }

  // 老键迁移：player.autoPlayOnReturn（返回软件自动播放）→ player.startupAutoPlay
  // （启动软件自动播放）。旧键在功能上从未接线（只有设置项、没有消费方），这里只把
  // 用户当时的开关意图带过来，语义由新功能重新定义（见 core/init/player/playInfo.ts）。
  if (setting && setting['player.startupAutoPlay'] === undefined && typeof setting['player.autoPlayOnReturn'] === 'boolean') {
    setting['player.startupAutoPlay'] = setting['player.autoPlayOnReturn']
  }
  // 低：迁完删旧键——此前只读不删，设置文件长期留着无消费方的旧键
  if (setting && 'player.autoPlayOnReturn' in setting) {
    delete (setting as Record<string, any>)['player.autoPlayOnReturn']
  }

  const updatedSetting = updateSetting(setting, true)

  // 导航顺序迁移：以当前 NAV_MENUS 为权威来源，把后续新增的菜单项
  // 补进老用户持久化的 navOrder 与 navFlatOrder 末尾，
  // 避免侧边栏、自定义排序列表、播放页 PagerView 在任何模式下丢失新增项。
  const allMenuIds = NAV_MENUS.map(m => m.id)
  const patchOrder = (key: 'common.navOrder' | 'common.navFlatOrder') => {
    const order = updatedSetting.setting[key] as string[] | undefined
    if (!Array.isArray(order)) return
    const set = new Set(order)
    const missing = allMenuIds.filter(id => !set.has(id))
    if (!missing.length) return
    // 空数组保持为空，让运行时 getEffectiveFlatOrder 回退到 navOrder / NAV_MENUS，
    // 避免把从未自定义过扁平顺序的老用户的 flat 顺序强制覆盖成默认顺序。
    if (order.length === 0 && key === 'common.navFlatOrder') return
    updatedSetting.setting[key] = [...order, ...missing]
  }
  patchOrder('common.navOrder')
  patchOrder('common.navFlatOrder')

  // 另外把 navOrder 里存在、navFlatOrder 仍缺失的项再补一次（兼容旧逻辑）。
  const navOrder = updatedSetting.setting['common.navOrder'] as string[] | undefined
  const navFlatOrder = (updatedSetting.setting['common.navFlatOrder'] as string[] | undefined) ?? []
  if (Array.isArray(navOrder) && navOrder.length) {
    const flatSet = new Set(navFlatOrder)
    const missing = navOrder.filter(id => !flatSet.has(id) && NAV_MENUS.some(m => m.id === id))
    if (missing.length) {
      updatedSetting.setting['common.navFlatOrder'] = [...navFlatOrder, ...missing]
    }
  }

  void saveData(storageDataPrefix.setting, updatedSetting.setting)

  return updatedSetting
}
