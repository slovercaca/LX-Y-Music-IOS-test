import { connectServer } from '@/plugins/sync'
import { updateSetting } from '@/core/common'
import { getSyncHost } from '@/plugins/sync/data'
import { triggerWebDAVSync } from '@/core/sync/webdavSync.ts'

export default async(setting: LX.AppSetting) => {
  if (setting['sync.webdav.url']) {
    void triggerWebDAVSync()
  }
  if (!setting['sync.enable']) return

  const host = await getSyncHost()
  // console.log(host)
  if (!host) {
    updateSetting({ 'sync.enable': false })
    return
  }
  // 冷启动自动连接：静默连接，不弹 "Sync connected" toast（手动/重连仍会弹）。
  // 存疑处理：补 catch——此前失败产生未处理 rejection（仅噪声、无数据后果，但污染日志）
  void connectServer(host, undefined, { silent: true }).catch((err: any) => {
    console.log('[Sync] 冷启动自动连接失败:', err?.message ?? err)
  })
}
