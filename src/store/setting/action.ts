import { updateSetting as mergeSetting } from '@/config/setting'
import state from './state'
import { storageDataPrefix } from '@/config/constant'
import { saveData } from '@/plugins/storage'

export default {
  initSetting(newSetting: LX.AppSetting) {
    state.setting = newSetting
  },
  updateSetting(newSetting: Partial<LX.AppSetting>) {
    const result = mergeSetting(newSetting)
    // 1-16：无键变更时不广播、不写盘——初始化回写相同值等场景不再造成
    // 无效广播 + 无谓写盘；返回实际变更键供 core/common 判断是否同步
    if (!result.updatedSettingKeys.length) return result.updatedSettingKeys
    state.setting = result.setting
    global.state_event.configUpdated(result.updatedSettingKeys, result.updatedSetting)
    void saveData(storageDataPrefix.setting, state.setting)
    return result.updatedSettingKeys
  },
}
