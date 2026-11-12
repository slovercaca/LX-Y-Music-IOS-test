/**
 * sim-offline-local-media-contract.js
 *
 * 「离线模式歌单 + 本地与下载：歌词/封面全部读本地」契约（2026-11-12）。
 *
 * 用户要求：离线模式下的歌单、以及「本地与下载」列表，播放与显示时
 * 歌词必须读本地 lrc（内嵌/同名 .lrc，含 lrc/ 目录），封面必须读本地
 * picture/（含内嵌封面提取），不允许绕过本地去联网取词/取图。
 *
 * 核查结论（本契约钉住的不变量）：
 *   - core/music/index.ts 的分发对所有来源一致适用离线语义：在线源与
 *     qs（汽水）源在离线模式下，取链先匹配已下载文件（未匹配抛
 *     「离线模式：该歌曲未下载」）、歌词走 localPlay 的 offlineOnly
 *     本地路径、封面只读 findLocalCachedPic（本地 picture/），都没有
 *     联网回退。此前 qs 三个分支绕过了离线判断，是唯一的系统性缺口。
 *   - localPlay.getLyricInfo：内嵌歌词 → findLyricForAudio（同目录 →
 *     lrc/ 子目录 → 父目录 lrc/）→ offlineOnly 时到此为止。
 *   - localPlay.getPicUrl：内嵌封面 → findPictureForAudio（同目录 →
 *     picture/ 子目录 → 父目录 picture/）→ findLibraryPicture（歌名-歌手
 *     模板基名）→ 之后才轮到 meta.picUrl 与在线匹配。
 *   - findLocalCachedPic（在线源封面）：任务本地封面 → 音频同名
 *     picture/ → 模板基名 picture/，离线与否都先于在线取图。
 *
 * 运行：node scripts/sim-offline-local-media-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  musicIndex: 'src/core/music/index.ts',
  localPlay: 'src/core/music/localPlay.ts',
  localLibrary: 'src/utils/localLibrary.ts',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))

const structuralReasons = (files) => {
  const reasons = []
  const idx = files.musicIndex

  // 离线语义覆盖全部来源：在线源 else 分支 + qs 分支，三个入口都要有
  const offlineChecks = (idx.match(/settingState\.setting\['player\.offlineMode'\] === true/g) || []).length
  if (offlineChecks < 6) {
    reasons.push(`index.ts 离线判断只有 ${offlineChecks} 处（应 ≥6：取链/封面/歌词 × 在线源与 qs 源）`)
  }
  const notDownloaded = (idx.match(/离线模式：该歌曲未下载/g) || []).length
  if (notDownloaded < 2) reasons.push('取链离线未匹配时缺少「离线模式：该歌曲未下载」拦截（qs 或在线源有一处漏了）')
  if (!idx.includes('offlineOnly: true')) reasons.push('离线歌词没有走 localPlay 的 offlineOnly 本地路径')
  if (!idx.includes('findOfflineLocalFile')) reasons.push('离线匹配已下载文件的 findOfflineLocalFile 不存在')
  if (!idx.includes('findLocalCachedPic')) reasons.push('封面本地缓存查找 findLocalCachedPic 不存在')

  // qs 三个分支各自的离线拦截锚点
  for (const anchor of [
    '离线模式对 qs 同样生效',
    '离线模式下 qs 封面也只读本地',
    '离线模式下 qs 歌词也只读本地',
  ]) {
    if (!idx.includes(anchor)) reasons.push(`qs 离线拦截缺失：${anchor}`)
  }

  // localPlay 歌词：内嵌 → sidecar lrc → offlineOnly 截止
  if (!files.localPlay.includes('findLyricForAudio')) reasons.push('localPlay 歌词没有读同名 .lrc（findLyricForAudio）')
  if (!files.localPlay.includes('if (offlineOnly) return buildLyricInfo')) {
    reasons.push('localPlay 歌词在 offlineOnly 时没有在本地路径截止（会联网取词）')
  }
  const embeddedAt = files.localPlay.indexOf('readLyric(target.filePath)')
  const sidecarAt = files.localPlay.indexOf('readSidecarLyric(target.filePath)')
  if (embeddedAt < 0 || sidecarAt < 0 || embeddedAt > sidecarAt) {
    reasons.push('localPlay 歌词顺序不是「内嵌 → 同名 .lrc」')
  }

  // localPlay 封面：内嵌 → picture/ sidecar → 本地库 picture/ → meta
  if (!files.localPlay.includes('findPictureForAudio')) reasons.push('localPlay 封面没有读 picture/ 同名封面')
  if (!files.localPlay.includes('findLibraryPicture')) reasons.push('localPlay 封面没有读本地库 picture/ 模板基名封面')
  const sidecarPicAt = files.localPlay.indexOf('findPictureForAudio(target.filePath)')
  // 2-9(b)：meta 行加了 offlineOnly 守卫（离线时只认 file://），锚点只取前缀，
  // 顺序判定（picture/ 在 meta 之前）不受影响
  const metaPicAt = files.localPlay.indexOf('if (!isRefresh && target.picUrl')
  if (sidecarPicAt < 0 || metaPicAt < 0 || sidecarPicAt > metaPicAt) {
    reasons.push('localPlay 封面顺序被改：picture/ 本地封面必须排在 meta.picUrl 之前')
  }

  // localLibrary 查找覆盖 music/ ↔ lrc//picture/ 的兄弟目录结构
  if (!files.localLibrary.includes('`${parentDir}/lrc/${base}.lrc`')) {
    reasons.push('findLyricForAudio 没有查父目录 lrc/（music/ 里的音频找不到 lrc/ 里的歌词）')
  }
  if (!files.localLibrary.includes('`${parentDir}/picture`')) {
    reasons.push('findPictureForAudio 没有查父目录 picture/')
  }

  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型（复刻关键纯逻辑）
// ---------------------------------------------------------------------------
const models = []

// —— 模型1：离线取链分发 ——
const resolveOfflineUrl = (source, offlineMode, matchedPath) => {
  // 在线源与 qs 源同一口径：离线时只认匹配到的本地文件
  if (offlineMode) {
    if (matchedPath) return matchedPath
    throw new Error('离线模式：该歌曲未下载')
  }
  return source === 'qs' ? 'cross-match' : 'online'
}
{
  let ok = resolveOfflineUrl('qs', true, '/music/a.flac') === '/music/a.flac' &&
    resolveOfflineUrl('wy', true, '/music/a.flac') === '/music/a.flac' &&
    resolveOfflineUrl('qs', false, null) === 'cross-match'
  try {
    resolveOfflineUrl('qs', true, null)
    ok = false
  } catch (e) {
    ok = ok && e.message === '离线模式：该歌曲未下载'
  }
  models.push(['离线取链：qs 与在线源同口径，命中本地文件用本地、未命中拦截', ok])
}

// —— 模型2：歌词本地优先顺序 ——
const resolveLyric = ({ embedded, sidecar, offlineOnly, online }) => {
  if (embedded) return 'embedded'
  if (sidecar) return 'sidecar'
  if (offlineOnly) return 'empty'
  return online ? 'online' : 'empty'
}
{
  const ok = resolveLyric({ embedded: 'x', sidecar: 'y', offlineOnly: true, online: 'z' }) === 'embedded' &&
    resolveLyric({ embedded: null, sidecar: 'y', offlineOnly: true, online: 'z' }) === 'sidecar' &&
    resolveLyric({ embedded: null, sidecar: null, offlineOnly: true, online: 'z' }) === 'empty' &&
    resolveLyric({ embedded: null, sidecar: null, offlineOnly: false, online: 'z' }) === 'online'
  models.push(['歌词：内嵌 → 同名 lrc → 离线截止/在线回退', ok])
}

// —— 模型3：封面本地优先顺序 ——
const resolvePic = ({ embedded, sidecarPic, libraryPic, metaPic, onlinePic }) => {
  if (embedded) return 'embedded'
  if (sidecarPic) return 'sidecar'
  if (libraryPic) return 'library'
  if (metaPic) return 'meta'
  return onlinePic ? 'online' : ''
}
{
  const ok = resolvePic({ embedded: null, sidecarPic: 'p', libraryPic: 'l', metaPic: 'm', onlinePic: 'o' }) === 'sidecar' &&
    resolvePic({ embedded: null, sidecarPic: null, libraryPic: 'l', metaPic: 'm', onlinePic: 'o' }) === 'library' &&
    resolvePic({ embedded: null, sidecarPic: null, libraryPic: null, metaPic: 'm', onlinePic: 'o' }) === 'meta'
  models.push(['封面：内嵌 → picture/ 同名 → picture/ 模板基名 → meta → 在线', ok])
}

const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const cases = []
{
  const tampered = {
    ...REAL,
    musicIndex: REAL.musicIndex.replace('离线模式对 qs 同样生效', 'qs 走跨平台匹配'),
  }
  cases.push(['qs 取链离线拦截被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    localPlay: REAL.localPlay.replace('if (offlineOnly) return buildLyricInfo', 'if (false) return buildLyricInfo'),
  }
  cases.push(['localPlay 离线歌词截止被删（会联网取词）', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    localLibrary: REAL.localLibrary.replace('`${parentDir}/lrc/${base}.lrc`', '`${audioDir}/lrc/${base}.lrc`'),
  }
  cases.push(['findLyricForAudio 父目录 lrc/ 查找被删', structuralReasons(tampered).length > 0])
}
const failedCases = cases.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
console.log('== 结构不变量 ==')
if (realReasons.length === 0) console.log('  PASS 全部结构不变量成立')
else for (const r of realReasons) console.log(`  FAIL ${r}`)

console.log('== 行为模型 ==')
for (const [name, pass] of models) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

console.log('== 反例自检（必须全部拦下） ==')
for (const [name, pass] of cases) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

const failed = realReasons.length + failedModels.length + failedCases.length
console.log(failed === 0 ? '\n全部通过' : `\n共 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
