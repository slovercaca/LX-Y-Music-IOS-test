import { createI18n, setLanguage as applyLanguage } from '@/lang/i18n'
import type { I18n } from '@/lang/i18n'
import { getDeviceLanguage } from '@/utils/tools'
import { setLanguage } from '@/core/common'

export default async(setting: LX.AppSetting) => {
  let lang = setting['common.langId']

  global.i18n = createI18n()

  // 1-22①：设置里没有有效语言时只推断并内存应用，不写回持久化——
  // 不把 null 覆盖掉（用户以后选语言时仍能重新推断）
  let isInferred = false
  if (!lang || !global.i18n.availableLocales.includes(lang)) {
    isInferred = true
    const deviceLanguage = (await getDeviceLanguage()).toLowerCase()
    if (
      typeof deviceLanguage == 'string' &&
      global.i18n.availableLocales.includes(deviceLanguage as I18n['locale'])
    ) {
      lang = deviceLanguage as I18n['locale']
    } else {
      lang = 'zh_cn'
    }
  }
  if (isInferred) {
    // 仅内存应用：不调 core/common.setLanguage（它会 updateSetting 写回）
    applyLanguage(lang)
    global.state_event.languageChanged(lang)
  } else {
    setLanguage(lang)
  }
}
