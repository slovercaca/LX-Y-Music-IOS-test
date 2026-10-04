import settingState from '@/store/setting/state'
import { updateSetting } from '@/core/common'
import { toast } from '@/utils/tools'
import { testConnection, resetClient } from '@/utils/webdav'
import { webDAVLog } from '@/core/webdavMusic/logger'
import {
  applyWebDAVServerProfile,
  findActiveWebDAVProfile,
  getActiveWebDAVProfileId,
  getFailoverCandidates,
  getWebDAVServerProfiles,
  type WebDAVServerProfile,
} from '@/core/webdavMusic/profiles'

/**
 * 哪些错误值得故障转移：
 * - 无 status 的网络层错误（DNS、超时、断网、TLS 失败等）
 * - 401/403/407：凭据不对，换一台服务器可能就通了
 * - 408/429/5xx：服务端问题，换一台可能就通了
 * 不转移的：404（同步流程里本就是"文件不存在"的正常语义，downloadFile/getStat
 * 已内部消化）、'WebDAV 未配置'（这是没填地址，不是连不上，轮换没有意义）、
 * SyntaxError（云端文件 JSON 损坏是数据问题，换服务器也一样）
 */
const isFailoverWorthyError = (error: any): boolean => {
  if (!error) return false
  // 数据本身坏了（云端文件 JSON 损坏）换服务器也没用，不轮换
  if (error instanceof SyntaxError) return false
  const msg = String(error?.message ?? '')
  if (msg.includes('未配置')) return false
  const status = error?.status ?? error?.response?.status
  if (status == null) return true
  return status === 401 || status === 403 || status === 407 || status === 408 || status === 429 || status >= 500
}

const notify = (message: string) => {
  if (settingState.setting['sync.webdav.failoverNotify']) toast(message, 'long')
}

/**
 * 按候选列表逐个尝试：应用配置 -> 测连通，通了就停下。
 * 返回最终生效的配置；全部不通时恢复轮换前的设置并返回 null
 * （不能把用户扔到一台刚证明连不上的服务器上），调用方抛原始错误。
 */
const rotateToWorkingProfile = async(fromName: string): Promise<WebDAVServerProfile | null> => {
  const settings = settingState.setting
  const snapshot = {
    'sync.webdav.url': settings['sync.webdav.url'],
    'sync.webdav.username': settings['sync.webdav.username'],
    'sync.webdav.password': settings['sync.webdav.password'],
  }
  const candidates = await getFailoverCandidates()
  for (const candidate of candidates) {
    try {
      await applyWebDAVServerProfile(candidate.id)
      await testConnection()
      webDAVLog.info(`[Failover] 「${fromName}」不可用，已切换到「${candidate.name}」`)
      notify(`「${fromName}」连接失败，已自动切换到「${candidate.name}」`)
      return candidate
    } catch (e: any) {
      // 这个候选也不通：记一笔，继续试下一个
      webDAVLog.warn(`[Failover] 候选「${candidate.name}」同样不可用：${e?.message ?? e}`)
    }
  }
  updateSetting(snapshot)
  resetClient()
  return null
}

const currentProfileName = async(): Promise<string> => {
  const profiles = await getWebDAVServerProfiles()
  return findActiveWebDAVProfile(profiles, await getActiveWebDAVProfileId())?.name ?? '当前服务器'
}

/**
 * 给备份/同步主流程套故障转移：
 * 1. 开关没开 -> 原样执行，零行为变化；
 * 2. 开了 -> 先预检连通性，不通就轮换（最常见的"服务器挂了"走这里，
 *    不会进到主流程里，也就不会有重复弹窗）；
 * 3. 主流程中途若再出现连接类错误 -> 轮换一次并重跑 task（只重跑一次，
 *    不套娃。注意：triggerWebDAVSync 里有首次同步/冲突确认弹窗，极端情况
 *    下重跑会让用户再选一次，属可接受的罕见代价）。
 * 全部候选都不通时，抛原始错误（外层按原来的"同步失败"处理）。
 */
export const runWithWebDAVFailover = async<T>(task: () => Promise<T>): Promise<T> => {
  if (!settingState.setting['sync.webdav.failoverEnabled']) return task()

  try {
    await testConnection()
  } catch (error: any) {
    if (!isFailoverWorthyError(error)) throw error
    const fromName = await currentProfileName()
    webDAVLog.warn(`[Failover] 预检失败（${error?.message ?? error}），开始轮换`)
    const ok = await rotateToWorkingProfile(fromName)
    if (!ok) throw error
  }

  try {
    return await task()
  } catch (error: any) {
    if (!isFailoverWorthyError(error)) throw error
    const fromName = await currentProfileName()
    webDAVLog.warn(`[Failover] 主流程中连接失败（${error?.message ?? error}），轮换后重试一次`)
    const ok = await rotateToWorkingProfile(fromName)
    if (!ok) throw error
    return task()
  }
}
