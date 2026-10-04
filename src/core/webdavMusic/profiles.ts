import { getData, saveData } from '@/plugins/storage'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { resetClient } from '@/utils/webdav'

/**
 * WebDAV 服务器配置（多服务器一键切换）。
 *
 * 背景：连接 WebDAV 听歌与「数据同步」共用 sync.webdav.url/username/password
 * 同一批设置键。用户有多台服务器（家里 NAS / 公司 / 朋友分享）时，每次切换
 * 都要手工重输地址账号密码，故把「地址 + 用户名 + 密码」打包成具名配置，
 * 存一份在本地，一键切换、也可删除/编辑。
 * 注意：密码以明文存于本机安全存储（与现有 sync.webdav.password 一致），
 * 仅用于本机连接，不会随同步上传到服务器。
 */
export interface WebDAVServerProfile {
  id: string
  /** 用户起的名字，如「家里 NAS」 */
  name: string
  url: string
  username: string
  password: string
  createdAt: number
  updatedAt: number
}

const PROFILES_KEY = '@webdav_server_profiles'
/** 最近一次「一键切换」命中的配置 id。只做高亮依据，不做其它用途。 */
const ACTIVE_ID_KEY = '@webdav_server_profiles_active_id'

const genId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

export const getWebDAVServerProfiles = async(): Promise<WebDAVServerProfile[]> => {
  const list = await getData<WebDAVServerProfile[]>(PROFILES_KEY)
  return Array.isArray(list) ? list : []
}

const persistProfiles = (profiles: WebDAVServerProfile[]) => saveData(PROFILES_KEY, profiles)

export interface WebDAVServerProfileInput {
  id?: string
  name: string
  url: string
  username: string
  password: string
}

/** 新增或更新一条配置（带 id 即更新）。返回保存后的配置。 */
export const saveWebDAVServerProfile = async(input: WebDAVServerProfileInput): Promise<WebDAVServerProfile> => {
  const profiles = await getWebDAVServerProfiles()
  const now = Date.now()
  const name = input.name.trim()
  const url = input.url.trim()
  const username = input.username.trim()
  if (input.id) {
    const idx = profiles.findIndex(p => p.id === input.id)
    if (idx >= 0) {
      profiles[idx] = { ...profiles[idx], name, url, username, password: input.password, updatedAt: now }
      await persistProfiles(profiles)
      return profiles[idx]
    }
  }
  const profile: WebDAVServerProfile = {
    id: genId(),
    name,
    url,
    username,
    password: input.password,
    createdAt: now,
    updatedAt: now,
  }
  profiles.push(profile)
  await persistProfiles(profiles)
  return profile
}

/** 删除一条配置。即使删的是当前生效的，也只删配置本身、不断开当前连接。 */
export const deleteWebDAVServerProfile = async(id: string): Promise<void> => {
  const profiles = await getWebDAVServerProfiles()
  await persistProfiles(profiles.filter(p => p.id !== id))
  // 高亮标记的清除是装饰性的：失败也不该把"删除成功"翻成"删除失败"
  if ((await getActiveWebDAVProfileId()) === id) {
    await saveData(ACTIVE_ID_KEY, null).catch(() => {})
  }
}

export const getActiveWebDAVProfileId = async(): Promise<string | null> => {
  const id = await getData<string>(ACTIVE_ID_KEY)
  return typeof id === 'string' && id ? id : null
}

/**
 * 一键切换：把配置写入共享的 sync.webdav.* 设置键（连接与同步两边同时生效），
 * 并重置缓存的 webdav client，下一次目录浏览/扫描/下载即用新凭据。
 * 注意：不清空已扫描歌曲缓存——若新服务器上没有这些文件，播放时会报 404
 * 并提示重新扫描；切回旧服务器时歌曲列表还在，无需重扫。
 */
export const applyWebDAVServerProfile = async(id: string): Promise<WebDAVServerProfile | null> => {
  const profiles = await getWebDAVServerProfiles()
  const profile = profiles.find(p => p.id === id)
  if (!profile) return null
  updateSetting({
    'sync.webdav.url': profile.url,
    'sync.webdav.username': profile.username,
    'sync.webdav.password': profile.password,
  })
  resetClient()
  // 高亮标记持久化是装饰性的：即使失败，切换本身（设置已写入）依然生效，
  // 不能让它把一次成功的切换翻成"连接失败"
  await saveData(ACTIVE_ID_KEY, profile.id).catch(() => {})
  return profile
}

/**
 * 当前生效的配置（用于高亮）。
 * 优先认 activeId——同 url+用户名可能存了多条（比如密码换了留了两条），
 * 只按 url+用户名匹配会高亮错。但用户也可能绕开切换、直接手改输入框，
 * 此时若 activeId 指向的配置与当前设置不一致，就退化成按 url+用户名匹配。
 */
export const findActiveWebDAVProfile = (
  profiles: WebDAVServerProfile[],
  activeId: string | null,
): WebDAVServerProfile | null => {
  const settings = settingState.setting
  const url = String(settings['sync.webdav.url'] || '').trim()
  const username = String(settings['sync.webdav.username'] || '').trim()
  if (!url) return null
  const matches = (p: WebDAVServerProfile) => p.url.trim() === url && p.username.trim() === username
  if (activeId) {
    const pinned = profiles.find(p => p.id === activeId)
    if (pinned && matches(pinned)) return pinned
  }
  return profiles.find(matches) ?? null
}

/** 同名检查（编辑时排除自身），避免列表里出现两个「家里 NAS」。 */
export const isDuplicateProfileName = (profiles: WebDAVServerProfile[], name: string, excludeId?: string): boolean => {
  const n = name.trim().toLowerCase()
  return profiles.some(p => p.id !== excludeId && p.name.trim().toLowerCase() === n)
}

/**
 * 故障转移候选：除当前生效配置外的所有配置，按保存顺序排。
 * 当前没命中任何配置时返回全部（一个个试）。
 */
export const getFailoverCandidates = async(): Promise<WebDAVServerProfile[]> => {
  const profiles = await getWebDAVServerProfiles()
  if (profiles.length < 2) return []
  const active = findActiveWebDAVProfile(profiles, await getActiveWebDAVProfileId())
  if (!active) return profiles
  return profiles.filter(p => p.id !== active.id)
}
