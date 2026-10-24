import { getData, saveData } from '@/plugins/storage'
import { updateSetting } from '@/core/common'
import settingActions from '@/store/setting/action'
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
  /**
   * 全量修复：该服务器的同步目录（sync.webdav.path）。
   * 此前配置里没有 path，故障转移切服务器后仍沿用旧 path 写文件，
   * 两台目录语义不同的服务器会就此分叉。老配置没有 path 时视为
   * “未指定”，切换时保留当前 path，不静默写错目录。
   */
  path?: string
  createdAt: number
  updatedAt: number
}

const PROFILES_KEY = '@webdav_server_profiles'
/** 最近一次「一键切换」命中的配置 id。只做高亮依据，不做其它用途。 */
const ACTIVE_ID_KEY = '@webdav_server_profiles_active_id'

const genId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

export const getWebDAVServerProfiles = async(): Promise<WebDAVServerProfile[]> => {
  const list = await getData<WebDAVServerProfile[]>(PROFILES_KEY)
  // 存疑处理：元素零校验时，存储被旧版本/备份写坏一条（缺 url/name）
  // 会让 findActive/故障转移候选直接 TypeError、整链挂掉无降级。
  // 读取时过滤掉形状不完整的条目。
  if (!Array.isArray(list)) return []
  return list.filter(p => !!p && typeof p.url === 'string' && typeof p.name === 'string')
}

const persistProfiles = (profiles: WebDAVServerProfile[]) => saveData(PROFILES_KEY, profiles)

export interface WebDAVServerProfileInput {
  id?: string
  name: string
  url: string
  username: string
  password: string
  path?: string
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
      // 编辑时没传 path 就保留旧 path，不把它清掉。
      profiles[idx] = { ...profiles[idx], name, url, username, password: input.password, ...(input.path !== undefined ? { path: input.path.trim() || undefined } : {}), updatedAt: now }
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
    // 新建时没传 path，就按创建时的当前同步目录存下来，之后切换到它
    // 时目录也跟着走，不会沿用上一台服务器的目录。
    path: input.path?.trim() || String(settingState.setting['sync.webdav.path'] || '/LX_Music/'),
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
export const applyWebDAVServerProfile = async(id: string, options?: { silent?: boolean }): Promise<WebDAVServerProfile | null> => {
  const profiles = await getWebDAVServerProfiles()
  const profile = profiles.find(p => p.id === id)
  if (!profile) return null
  // 中：故障转移内部调用传 silent——走 core 的 updateSetting 会
  // markSettingsChanged 标脏、再调度一次注定失败的同步（与标记清除
  // 时序赛跑还可能残留 true 反复触发）。静默路径直写 store。
  const write = options?.silent ? settingActions.updateSetting : updateSetting
  write({
    'sync.webdav.url': profile.url,
    'sync.webdav.username': profile.username,
    'sync.webdav.password': profile.password,
    // 全量修复：配置有 path 就一起切换；老配置没有 path 时保留当前 path。
    ...(profile.path ? { 'sync.webdav.path': profile.path } : {}),
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
  const password = String(settings['sync.webdav.password'] || '')
  // 密码也纳入判定（W19）：同地址同用户名、只是密码不同（改过密码留了两条）时不再高亮错配置
  const matches = (p: WebDAVServerProfile) => p.url.trim() === url && p.username.trim() === username && p.password === password
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
