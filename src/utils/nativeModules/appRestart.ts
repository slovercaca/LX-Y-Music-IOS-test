import { NativeModules } from 'react-native'

const AppRestartModule = NativeModules.AppRestartModule as
  | { restart?: () => void }
  | undefined

/**
 * 重启应用（JS Bundle 重载，见 ios/AppDelegate.mm 的 AppRestartModule）。
 * iOS 不允许应用自行退出重进，原生 exitApp 刻意保持 no-op，
 * 所以这里走 bridge reload：JS 状态全部重新初始化，同步下来的
 * 设置/音源在新一轮启动里生效。原生模块状态不变，若 reload 不可用
 * 则抛错，调用方回退到“请手动关闭重开”提示。
 */
export const restartApp = (): void => {
  if (typeof AppRestartModule?.restart === 'function') {
    AppRestartModule.restart()
    return
  }
  const DevSettings = (NativeModules as any).DevSettings
  if (typeof DevSettings?.reload === 'function') {
    DevSettings.reload()
    return
  }
  throw new Error('当前版本不支持应用内重启，请手动关闭后重新打开')
}
