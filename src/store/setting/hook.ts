import { useEffect, useState } from 'react'
import state from './state'

export const useSetting = () => {
  const [setting, updateSetting] = useState(state.setting)

  useEffect(() => {
    const handleUpdate = () => {
      updateSetting(state.setting)
    }
    global.state_event.on('configUpdated', handleUpdate)
    return () => {
      global.state_event.off('configUpdated', handleUpdate)
    }
  }, [])

  return setting
}

export const useSettingValue = <T extends keyof LX.AppSetting>(key: T): LX.AppSetting[T] => {
  const [value, update] = useState(state.setting[key])

  useEffect(() => {
    // 1-18(a)：key 变化时重同步当前值——此前只重订阅，值仍停留在旧 key 上
    update(state.setting[key])
    const handleUpdate = (keys: Array<keyof LX.AppSetting>) => {
      if (!keys.includes(key)) return
      update(state.setting[key])
    }
    global.state_event.on('configUpdated', handleUpdate)
    return () => {
      global.state_event.off('configUpdated', handleUpdate)
    }
  }, [key])

  return value
}
