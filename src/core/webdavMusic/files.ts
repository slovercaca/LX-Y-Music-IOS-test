import { Buffer } from 'buffer'
import type { FileStat } from 'webdav'
import {
  downloadFile as rnDownloadFile,
  existsFile,
  moveFile,
  read,
  readDir,
  readFile,
  stat as statLocalFile,
  unlink,
} from '@/utils/fs'
import { getClient, getWebDAVAuthHeaders, readWebDAVCredentials } from './client'
import { webDAVLog } from './logger'

/**
 * WebDAV 远端文件原语（重写版）。
 *
 * 职责：所有与服务器直接打交道的读写操作。调用方（library / sync）
 * 只用这里的函数，不再各自拼 webdav 库调用。
 *
 * 兼容承诺：
 * - uploadFile / downloadFile / getStat / uploadBinaryFile 与旧 utils/webdav.ts
 *   同名同签名，行为一致（404 → null、超时 2 分钟、分阶段回调）
 * - downloadToFileAtomic / checkWebDAVRemoteExists 与旧 drive.ts 同名同行为
 */

export interface RemoteEntry {
  /** webdav 库返回的 filename（可做唯一 id） */
  id: string
  name: string
  /** 以 / 开头的完整远端路径 */
  path: string
  type: 'file' | 'directory'
  size?: number
  lastmod?: string
}

const toEntry = (item: any, parentPath?: string): RemoteEntry => ({
  id: item.filename,
  name: item.basename,
  // P1-5：path 直接用服务器返回的 filename（权威值），而非 parentPath+basename 拼接。
  // 拼接在百分号编码差异、Unicode NFC/NFD 规范化差异（macOS/Linux NAS 常见）时
  // 会与服务器真实路径对不上，导致后续请求 404。
  path: item.filename || (parentPath ? `${parentPath}/${item.basename}` : `/${item.basename}`),
  type: item.type,
  size: item.size,
  lastmod: item.lastmod,
})

/** 列出目录内容；404/409（不存在/冲突）返回空数组，其余错误上抛 */
export const listRemoteEntries = async(dirPath: string): Promise<RemoteEntry[]> => {
  const client = getClient()
  let contents: any[]
  try {
    // 全量修复：目录列举此前无超时，服务器挂起时扫描/同步永久卡住。
    contents = (await withTimeout(
      client.getDirectoryContents(dirPath) as Promise<unknown>,
      60000,
      `列出远端目录超时（60 秒无响应）：${dirPath}`,
    )) as any[]
  } catch (error: any) {
    webDAVLog.error('listRemoteEntries error', { dirPath, status: error?.status })
    if (error?.status === 404 || error?.status === 409) return []
    throw error
  }
  return contents.map(item => toEntry(item, dirPath === '/' ? '' : dirPath))
}

/** 只列子目录（供目录浏览用），按名称排序 */
export const listRemoteSubDirs = async(dirPath: string): Promise<LX.WebDAV.DriveFolder[]> => {
  const entries = await listRemoteEntries(dirPath)
  return entries
    .filter(e => e.type === 'directory')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<LX.WebDAV.DriveFolder>(e => ({
      id: e.id,
      name: e.name,
      path: e.path,
    }))
}

/**
 * WebDAV 错误的可读描述——webdav 库的错误对象经常只有 status/code，
 * stack/message 可能为 undefined，旧代码 `error.stack ?? error.message`
 * 会打出 "Failed: undefined"，甚至空日志，下次排查无从下手。
 * 这里一律带上 message、status、code 和可枚举键，永不为空。
 */
export const describeWebDAVError = (error: any): string => {
  if (error == null) return '未知错误（空错误对象）'
  if (typeof error === 'string') return error || '未知错误（空字符串）'
  const message = error.stack ?? error.message ?? ''
  const status = error.status ?? error.response?.status ?? ''
  const code = error.code ?? ''
  let keys = ''
  try {
    keys = Object.keys(error).join(',')
  } catch { /* ignore */ }
  const parts = [`${message || '无 message'}`]
  if (status !== '') parts.push(`status=${status}`)
  if (code !== '') parts.push(`code=${code}`)
  if (keys) parts.push(`keys=${keys}`)
  return parts.join(' ')
}

/**
 * 递归确保远端目录存在（逐级创建，跳过已存在的层级）。
 * 与旧 ensureDir 行为一致：分段 createDirectory，409/已存在继续。
 */
export const ensureRemoteDir = async(dirPath: string): Promise<void> => {
  const client = getClient()
  const segments = String(dirPath || '/').split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    try {
      // 全量修复：建目录也加 30 秒超时，否则挂起的 MKCOL 会卡住整个上传。
      await withTimeout(
        client.createDirectory(current) as Promise<unknown>,
        30000,
        `创建远端目录超时（30 秒无响应）：${current}`,
      )
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status
      // 中：只有 405 才是「已存在」（RFC 4918）；409 是父集合不存在/
      // 冲突——此前把 409 也当已存在跳过，最终 PUT 才以 409 失败，
      // 报错点与真因脱节。409/412 先 stat 核实，真的在才继续。
      if (status === 405) continue
      const exists = await checkWebDAVRemoteExists(current).catch(() => false)
      if (exists) continue
      // 2026-10-24：建目录失败时记清状态码与 stat 结果再抛，
      // 不再让调用方只看到一个空 ERROR——删了云端文件/目录后
      // 上传不生效，最可能卡的就是这一步（MKCOL 不支持/只读/权限）。
      webDAVLog.error('ensureRemoteDir: 建目录失败', { dirPath: current, error: describeWebDAVError(error), exists })
      throw error
    }
  }
}

/** stat：存在返回 FileStat，不存在（404）返回 null（与旧 getStat 一致） */
export const getStat = async(remotePath: string): Promise<FileStat | null> => {
  try {
    // 中-6：30s 超时——服务器只挂不回时 stat 永不结算，上传的续传预检/传后校验
    // 会把队列 worker 永久挂住（看门狗对无 abort 句柄的阶段无限续命、校验阶段
    // 又被豁免），暂停恢复也救不回，只能杀 App。
    // 全量修复：超时定时器必须在结算后 clear，否则每次 stat 残留一个定时器。
    return (await withTimeout(
      getClient().stat(remotePath) as Promise<FileStat>,
      30000,
      '检查远端文件超时（30 秒无响应）',
    ))
  } catch (error: any) {
    // P2（2026-10-06）：404 判断统一口径 error?.status ?? error?.response?.status，
    // 与 ensureRemoteDir 一致（某错误只带 response.status 时不再误抛）
    if ((error?.status ?? error?.response?.status) === 404) return null
    throw error
  }
}

/** 检查远端路径是否存在（存在 true / 不存在 false） */
export const checkWebDAVRemoteExists = async(remotePath: string): Promise<boolean> => {
  return (await getStat(remotePath).catch(() => null)) != null
}

export type RemoteExistsState = 'exists' | 'notExists' | 'unknown'

/**
 * 三态存在检查（W2）：网络错误/服务器异常时返回 unknown 而不是误判「不存在」。
 * 旧 checkWebDAVRemoteExists 把任何失败都吞成 false，上传冲突预检会因此
 * 绕过覆盖确认、把已有文件直接覆盖掉。
 */
export const checkWebDAVRemoteState = async(remotePath: string): Promise<RemoteExistsState> => {
  try {
    const stat = await getStat(remotePath)
    return stat ? 'exists' : 'notExists'
  } catch {
    return 'unknown'
  }
}

/**
 * 读远端文本文件；不存在（404）返回 null，其余错误上抛。
 * 同步流程用它读 playlists.json / settings.json / user_apis.json。
 * 全量修复：409 不再当成“不存在”——409 可能是锁定/冲突/父目录问题，
 * 文件实际存在；当成缺失会让同步误判为云端无文件、走上传覆盖掉它。
 * 文本下载加 60 秒超时，服务器挂起时同步不再永久占住 isSyncing。
 */
export const downloadFile = async(remotePath: string): Promise<string | null> => {
  const client = getClient()
  try {
    const result: any = await withTimeout(
      client.getFileContents(remotePath, { format: 'text' }) as Promise<unknown>,
      60000,
      `读取远端文件超时（60 秒无响应）：${remotePath}`,
    )
    return typeof result === 'string' ? result : null
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status
    if (status === 404) return null
    throw error
  }
}

/**
 * 2026-10-24 截断修复：先 DELETE 再 PUT；2026-10-24 全量修复：DELETE
 * 非 404 失败必须中止本次上传。
 * 部分 WebDAV 服务器（本轮真机实锤）的 PUT 不截断旧文件：新内容更短时
 * 只覆盖开头、旧尾巴保留，远端文件直接变坏 JSON。DELETE 后再 PUT，
 * 新文件从 0 开始写，就不存在尾巴。文件本就不存在时 DELETE 报 404，
 * 忽略；其他 DELETE 失败（405/403/权限/网络）时绝不能继续 PUT——
 * 继续 PUT 只会把好好的旧文件腐蚀成坏文件，大小校验只能事后发现，
 * 不能阻止腐蚀。保住旧文件、明确报错，让用户先修权限再重试。
 */
const deleteRemoteFileIfExists = async(remotePath: string): Promise<void> => {
  try {
    await getClient().deleteFile(remotePath)
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status
    if (status === 404) return
    // 复查修复：409 可能是父目录不存在（部分服务器对缺失父目录的
    // DELETE 报 409），不是“旧文件删不掉”——不能因此中止，否则
    // 父目录缺失时本可由 PUT 隐式建目录/由 PUT 409 明确报错的路径
    // 全被堵死。409 直接放行，让后续 PUT 的成败说了算（PUT 成功
    // 即落盘，PUT 409 即明确失败，大小校验是最后一道关）。
    if (status === 409) return
    const err = new Error(`上传前删除远端旧文件失败，上传已中止以保住旧文件：${remotePath}（${describeWebDAVError(error)}）`)
    webDAVLog.error('先 DELETE 旧远端文件失败，中止上传', { remotePath, error: describeWebDAVError(error) })
    throw err
  }
}

/** 带超时的 Promise 竞速：超时不取消底层请求，但能让调用方不再永久挂起 */
const withTimeout = async<T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 写远端文本文件（先确保父目录存在） */
export const uploadFile = async(remotePath: string, content: string): Promise<void> => {
  const client = getClient()
  const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/'
  // 2026-10-24：删了云端文件/目录后上传不生效的修复。
  // 此前建目录失败就直接抛，PUT 连试的机会都没有——而部分服务器
  // 不支持 MKCOL、或 PUT 本身会隐式建父目录，建目录失败不等于
  // PUT 一定失败。改成：建目录失败只记 warn，仍尝试 PUT；
  // PUT 后再 stat 验远端是否真的落盘——PUT “成功”但服务器只读/
  // 配额满/写到别处时，以前会误报“上传成功”，现在会明确抛错。
  try {
    await ensureRemoteDir(parent)
  } catch (error: any) {
    webDAVLog.warn('uploadFile: 确保父目录失败，仍尝试直接 PUT', { remotePath, parent, error: describeWebDAVError(error) })
  }
  const expectedBytes = Buffer.byteLength(content, 'utf8')
  // 全量修复：大小不符时删掉已损坏的远端文件、整文件重传一次，再不符才
  // 明确报错；只报错不重试的话，坏文件会一直留在云端等用户手动处理。
  // DELETE 失败会直接中止（见 deleteRemoteFileIfExists），不会腐蚀旧文件。
  // 文本 PUT 加 120 秒超时，服务器挂起时不再永久占住同步流程。
  let lastStat: any = null
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    await deleteRemoteFileIfExists(remotePath)
    try {
      const abortController = new AbortController()
      // 竞速超时：signal 是否被库转发无法保证，竞速才能确保 120 秒后一定
      // 结算、不永久占住同步流程；底层请求若仍在跑，下一次 DELETE+重传
      // 会以新文件覆盖它，大小校验是最后一道关。
      await withTimeout(
        client.putFileContents(remotePath, content, { overwrite: true, signal: abortController.signal } as any) as Promise<unknown>,
        120000,
        `上传超时（120秒无响应）：${remotePath}`,
      )
    } catch (error: any) {
      webDAVLog.error('uploadFile: PUT 失败', { remotePath, parent, error: describeWebDAVError(error) })
      throw error
    }
    let stat: any = null
    let statError: any = null
    try {
      stat = await getStat(remotePath)
    } catch (error: any) {
      statError = error
    }
    if (statError) {
      webDAVLog.warn('uploadFile: PUT 成功但远端校验 stat 失败，按成功处理', { remotePath, error: describeWebDAVError(statError) })
      lastStat = null
      lastError = null
      break
    }
    if (!stat) {
      lastError = new Error(`上传后远端文件不存在（服务器未落盘）：${remotePath}，请检查服务器是否只读、配额或路径权限`)
      webDAVLog.error('uploadFile: PUT 后验远端失败', { remotePath, parent })
      break
    }
    const remoteSize = Number((stat as any)?.size)
    if (!Number.isFinite(remoteSize)) {
      webDAVLog.warn('uploadFile: 远端未返回大小，大小校验跳过（DELETE 已先行，截断风险已大幅降低）', { remotePath, expectedBytes })
      lastStat = stat
      lastError = null
      break
    }
    if (remoteSize !== expectedBytes) {
      lastError = new Error(`上传后远端大小不符（疑似服务器未截断旧文件）：${remotePath}，期望 ${expectedBytes} 字节、远端 ${remoteSize} 字节`)
      webDAVLog.error('uploadFile: PUT 后字节数校验失败', { remotePath, parent, remoteSize, expectedBytes, contentLength: content.length, attempt })
      lastStat = stat
      if (attempt === 0) continue
      break
    }
    lastStat = stat
    lastError = null
    break
  }
  if (lastError) throw lastError
  webDAVLog.info('uploadFile: 成功', { remotePath, remoteSize: (lastStat as any)?.size ?? null, expectedBytes, contentLength: content.length })
}

/**
 * 上传本地二进制文件（重写版，行为与旧版一致）：
 * - 先校验本地文件：stat 失败 / 是目录 / 大小为 0 直接抛错，
 *   不再把读失败吞成 size: 0 的无效上传
 * - 先确保远端父目录存在
 * - base64 → Buffer → putFileContents，超时 2 分钟
 * - onStage 分阶段回调（定位上传卡死用）
 */
export const uploadBinaryFile = async(
  remotePath: string,
  localPath: string,
  contentType?: string,
  onStage?: (stage: string) => void,
): Promise<void> => {
  const report = (stage: string) => {
    webDAVLog.info(`[upload] ${stage}`, { remotePath })
    onStage?.(stage)
  }

  report('正在校验本地文件…')
  // stat 精确校验：失败 / 是目录 / 大小为 0 直接抛错，
  // 不再把读失败吞成 size: 0 的无效上传
  const info = await statLocalFile(localPath).catch(() => null)
  if (!info || info.isDirectory || !info.size) {
    throw new Error(`本地文件不可读或为空：${localPath}`)
  }

  report('正在准备上传目录…')
  const parent = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/'
  await ensureRemoteDir(parent)

  report('正在读取本地文件…')
  const base64 = await readFile(localPath, 'base64')
  if (!base64) throw new Error(`本地文件读取失败：${localPath}`)

  report('正在上传到服务器…')
  const client = getClient()
  const buffer = Buffer.from(base64, 'base64')
  // 2026-10-24 截断修复：同 uploadFile，先 DELETE 再 PUT，防小文件
  // 覆盖大文件留尾巴（文本同步文件已实锤，音乐/封面/歌词同理）。
  // 全量修复：大小不符时删掉坏文件、重传一次，再不符才报错。
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    await deleteRemoteFileIfExists(remotePath)
    const abortController = new AbortController()
    try {
      await withTimeout(
        client.putFileContents(remotePath, buffer, {
          overwrite: true,
          ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
          signal: abortController.signal,
        } as any) as Promise<unknown>,
        120000,
        `上传超时（120秒无响应）：${remotePath}`,
      )
    } catch (e: any) {
      if (abortController.signal.aborted) {
        throw new Error(`上传超时（120秒无响应）：${remotePath}`)
      }
      throw e
    }
    report('正在校验远端文件…')
    let remoteStat: any = null
    let remoteStatError: any = null
    try {
      remoteStat = await getStat(remotePath)
    } catch (error: any) {
      remoteStatError = error
    }
    if (remoteStatError) {
      webDAVLog.warn('uploadBinaryFile: PUT 成功但远端校验 stat 失败，按成功处理', { remotePath, error: describeWebDAVError(remoteStatError) })
      lastError = null
      break
    }
    if (!remoteStat) {
      lastError = new Error(`上传后远端文件不存在（服务器未落盘）：${remotePath}，请检查服务器是否只读、配额或路径权限`)
      break
    }
    const remoteSize = Number((remoteStat as any)?.size)
    if (!Number.isFinite(remoteSize)) {
      webDAVLog.warn('uploadBinaryFile: 远端未返回大小，大小校验跳过（DELETE 已先行，截断风险已大幅降低）', { remotePath, expectedBytes: info.size })
      lastError = null
      break
    }
    if (remoteSize !== info.size) {
      lastError = new Error(`上传后远端大小不符（疑似服务器未截断旧文件）：${remotePath}，期望 ${info.size} 字节、远端 ${remoteSize} 字节`)
      webDAVLog.error('uploadBinaryFile: PUT 后字节数校验失败', { remotePath, remoteSize, expectedBytes: info.size, attempt })
      if (attempt === 0) continue
      break
    }
    lastError = null
    break
  }
  if (lastError) throw lastError
  report('上传完成')
}

/**
 * 兼容旧版本毒化缓存：此前下载未校验 statusCode，401/404 的错误页面
 * （XML/HTML，首字节必为 '<'）会被当成正常文件缓存。音频文件的首字节
 * 不可能是 '<'，命中则删掉并走正常下载流程；读不到首字节时保守地视为有效。
 */
export const isPoisonedCache = async(filePath: string, expectedSize?: number): Promise<boolean> => {
  // 中：此前只看首字节——0 字节文件与读失败不可区分、截断音频首字节
  // 合法也会判有效，坏文件每次交给播放器都失败且永不重新下载。有
  // 期望大小（扫描记录的 meta.size）时先比大小，0 字节直接判毒。
  // 全量修复：stat 与读同时失败时不再当成“不毒”——文件根本读不到，
  // 当成有效只会让播放器/封面拿到一个不存在的文件，判毒重下才是对的。
  try {
    const st = await statLocalFile(filePath)
    const size = Number((st as any)?.size ?? -1)
    if (size === 0) return true
    if (expectedSize && expectedSize > 0 && size > 0 && size !== expectedSize) return true
  } catch { /* stat 失败时退回首字节判定 */ }
  const head = await read(filePath, 1, 0, 'utf8').catch(() => null)
  if (head === null) return true
  return head === '<'
}

/**
 * 原子下载：先下载到唯一临时文件，statusCode/bytesWritten 校验通过后再改名到目标路径。
 * 解决两个问题：
 * 1) RNFS downloadFile 在 HTTP 错误（401/404 等）时 resolve（靠 statusCode 识别）、
 *    网络中断时 reject，两种失败都会在目标路径留下错误页面/截断文件；毒缓存检查
 *    （首字节 '<'）识别不出截断的音频/图片，下次 existsFile 直接命中坏文件、永久
 *    播不出。走临时文件可保证任何失败都不会污染目标路径。
 * 2) 预加载与播放可能并发下载同一文件，唯一临时文件名保证互不删除对方的文件；
 *    改名时若目标已存在（另一路已先落盘）则直接复用。
 */
export const downloadToFileAtomic = async(options: {
  url: string
  targetPath: string
  statusError: (statusCode: number) => string
  moveError: string
  // P2（2026-10-06）：远端文件预期大小（字节）。0 字节下载时：
  // 若 expectedSize === 0，视为合法空文件，算成功；否则按失败处理。
  // 不传时保持旧行为（0 字节判失败），避免存量调用方语义变化。
  expectedSize?: number
}): Promise<void> => {
  const { url, targetPath, statusError, moveError, expectedSize } = options
  const tmpPath = `${targetPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`
  const cleanupTmp = () => unlink(tmpPath).catch(() => {})
  try {
    // 诊断日志：404 排查用。记录完整 URL 和 headers（密码脱敏）。
    // 如果下载 404 但 PROPFIND 正常，对比两者差异定位问题。
    // 高-2 安全：Authorization 只发给已配置的 WebDAV 服务器同源地址。
    // 本函数也被用来下载外部封面图（酷我/酷狗 CDN），无条件带头会把账密发给第三方。
    let headers = getWebDAVAuthHeaders()
    let sameOrigin = false
    let authPresentBeforeStrip = !!headers.Authorization
    try {
      const creds = readWebDAVCredentials()
      sameOrigin = creds ? new URL(url).origin === new URL(creds.url).origin : false
      if (!sameOrigin) {
        const { Authorization: _auth, ...rest } = headers
        headers = rest
      }
    } catch {
      const { Authorization: _auth, ...rest } = headers
      headers = rest
    }
    const safeHeaders: Record<string, string> = {}
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') {
        // 只显示认证类型和长度，不显示具体值
        const v = headers[k] || ''
        safeHeaders[k] = v.split(' ')[0] + ' <' + v.length + ' chars>'
      } else {
        safeHeaders[k] = headers[k]
      }
    }
    // 2026-10-24 真机日志诊断：下载日志里既看不到 Authorization、也看不到
    // bytesWritten——无法判断是鉴权被剥离、还是 RNFS 没回字节数。把这两个
    // 诊断位直接记进开始日志（只记有无/同源，不记凭据本身）。
    webDAVLog.info('downloadToFileAtomic: 开始下载', { url, headers: safeHeaders, authPresent: !!headers.Authorization, authPresentBeforeStrip, sameOrigin })
    // 诊断：不发送自定义 User-Agent（当前为 Android Chrome UA，在 iOS 上可疑），
    // 让 RNFS 用系统默认。部分 NAS/WAF 会拦截异常 UA。
    const { 'User-Agent': _ua, ...headersNoUA } = headers
    const result = await rnDownloadFile(url, tmpPath, { headers: headersNoUA }).promise
    // 2026-10-24 修复（两处顺序/口径问题）：
    // 1) 状态码必须先验——此前先验字节数，401/403/404 的错误页面
    //    （小文件、无 bytesWritten）会被误报成“截断”，真因被掩盖，
    //    播放失败也永远看不到 401/404 提示。
    // 2) 字节数以落盘文件实际大小为准——RNFS 的 bytesWritten 在部分
    //    iOS/服务器组合下可能为 undefined，导致即使下载完整也恒判
    //    “不符”，所有 WebDAV 歌曲都播不出。stat 失败时才回退到 bytesWritten。
    const statSize = await statLocalFile(tmpPath).then(info => Number(info.size)).catch(() => null)
    const actualSize = statSize ?? result.bytesWritten
    // 全量修复：本函数从不发 Range 请求，206 部分内容绝不该出现；
    // 代理/服务器异常返回 206 时，半截文件不能当成完整文件落盘。
    if (result.statusCode === 206) {
      webDAVLog.error('downloadToFileAtomic: 收到意外的 206 部分内容，拒绝落盘', { url, statusCode: result.statusCode, statSize, actualSize })
      throw new Error(statusError(result.statusCode))
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      webDAVLog.error('downloadToFileAtomic: 下载失败', {
        statusCode: result.statusCode,
        url,
        headers: safeHeaders,
        bytesWritten: result.bytesWritten,
        statSize,
        authPresent: !!headers.Authorization,
        sameOrigin,
      })
      throw new Error(statusError(result.statusCode))
    }
    // P2（2026-10-06）：0 字节下载不再一律判失败。若远端确为空文件（expectedSize === 0），算成功
    const isEmptyFileOk = actualSize === 0 && expectedSize === 0
    // 高：给了 expectedSize 就必须精确相等——此前只验状态码与非空，
    // 截断文件（网络中断但连接正常关闭）会被 move 成正式缓存且无法自愈
    if (expectedSize != null && expectedSize > 0 && actualSize != null && actualSize !== expectedSize) {
      webDAVLog.error('downloadToFileAtomic: 字节数不符（疑似截断）', {
        url,
        statusCode: result.statusCode,
        bytesWritten: result.bytesWritten,
        statSize,
        actualSize,
        expectedSize,
      })
      throw new Error(`下载不完整：期望 ${expectedSize} 字节，实际 ${actualSize} 字节`)
    }
    if (!actualSize && !isEmptyFileOk) {
      webDAVLog.error('downloadToFileAtomic: 下载失败', {
        statusCode: result.statusCode,
        url,
        headers: safeHeaders,
        bytesWritten: result.bytesWritten,
        statSize,
        // 提示：如果 PROPFIND 能列出文件但 GET 404，
        // 可能是服务器对未认证请求返回 404（鉴权头有问题），
        // 或 URL 编码与服务器期望不一致。
      })
      throw new Error(statusError(result.statusCode))
    }
    try {
      await moveFile(tmpPath, targetPath)
    } catch {
      // 全量修复：改名失败不能只看“目标存在”就复用——磁盘满、权限、
      // 目录被删时目标处可能正好有个旧毒/截断文件，复用等于把失败
      // 伪装成成功。只有目标大小与本次下载一致（或本次无期望大小
      // 且目标非空）时，才算并发另一路先落盘的合法复用；否则如实抛错。
      await cleanupTmp()
      if (await existsFile(targetPath)) {
        const targetSize = await statLocalFile(targetPath).then(info => Number(info.size)).catch(() => null)
        const sizeMatches = expectedSize != null && expectedSize > 0
          ? targetSize === expectedSize
          : targetSize != null && targetSize > 0
        if (sizeMatches) {
          webDAVLog.info('downloadToFileAtomic: 并发下载已由另一路完成，复用缓存', { targetPath, targetSize, expectedSize })
          return
        }
        webDAVLog.error('downloadToFileAtomic: 改名失败且目标文件大小不符，拒绝复用旧文件', { targetPath, targetSize, expectedSize, actualSize })
      }
      throw new Error(moveError)
    }
  } catch (err) {
    await cleanupTmp()
    throw err
  }
}

/**
 * 启动期清扫残留的 .tmp 文件（P2 2026-10-06）。
 * downloadToFileAtomic 崩溃时可能在缓存目录留下 .tmp，永不清理会越积越多。
 * 在模块加载时异步执行，不阻塞启动。
 */
const cleanStaleTmpFiles = async(): Promise<void> => {
  try {
    // 中：原先动态 import 的 getCacheDir 在 tools.ts 根本不存在，解构得
    // undefined、调用即 TypeError 被外层 catch 吞掉——清扫从未执行过，
    // 且目录还少了 /WebDAV 一段。改与 library.ts 同口径计算缓存根。
    const { temporaryDirectoryPath, getWebDAVPrivateDirectory } = await import('@/utils/fs')
    const cacheDir = `${temporaryDirectoryPath}/WebDAV`
    // 全量修复：批量封面中转目录的残留此前从不清，App 被杀后会堆积。
    let privateTmpDir = ''
    try { privateTmpDir = `${getWebDAVPrivateDirectory()}/cover_upload_tmp` } catch { /* 忽略 */ }
    const dirs = [`${cacheDir}/covers`, `${cacheDir}/music`, ...(privateTmpDir ? [privateTmpDir] : [])]
    for (const dir of dirs) {
      try {
        const entries = await readDir(dir)
        for (const entry of entries) {
          // 中转目录里的文件全是临时文件（启动时不可能有进行中的批量
          // 封面任务），全部清掉；缓存目录只清 .tmp，避免误删正常缓存。
          if (dir === privateTmpDir || entry.name.endsWith('.tmp')) {
            await unlink(entry.path).catch(() => {})
            webDAVLog.info('cleanStaleTmpFiles: 删除残留', { path: entry.path })
          }
        }
      } catch {
        // 目录不存在，跳过
      }
    }
  } catch (err) {
    // 清扫失败不影响主流程，但至少留一条日志，不再静默吞掉
    webDAVLog.warn('cleanStaleTmpFiles: 清扫失败', { err })
  }
}

// 模块加载时触发清扫（fire-and-forget）
void cleanStaleTmpFiles()

