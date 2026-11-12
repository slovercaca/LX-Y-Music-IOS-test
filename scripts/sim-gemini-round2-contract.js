/**
 * sim-gemini-round2-contract.js
 *
 * Gemini 2026-11-12 第二轮审计重点修复契约（2026-11-12）。
 *
 * 钉住本轮最关键的 10 处修复不变量（内容锚点 + 行为模型）：
 *   - 4-7：request.js 的 JSON 判定用 startsWith，带 charset 的 Content-Type
 *     不再把 body 变成 "[object Object]"（qs 歌单 POST 必败）。
 *   - 2-2：定时退出检查只在 ended/终态分支执行，不再放在 case 'state' 末尾
 *     （任意状态事件都退 App）。
 *   - 5-2：深色模式激活态文字映射 c-1000（白色），不再是近乎不可见的
 *     rgb(92,92,92)。
 *   - 3-6：triggerWebDAVSync 失败返回 false，不再无条件返回 true（脏标志
 *     被误清、失败后不再自动重调度）。
 *   - 2-3：占位音轨过滤用 isTempId，不再用互斥的 isEmpty + /restorePlay$/
 *     组合（恒假）。
 *   - 5-1：SonglistDetail 搜索期间不把过滤列表写回全局 store；最终写回
 *     补高-2 id/source 守卫。
 *   - 6-7：MP3 写标签双句柄判空 + headerSize 越界中止 + 256KB 分块流式
 *     拷贝（不再整首读入内存、不再能把文件覆盖为 0 字节）。
 *   - 4-21：kg 歌单正则未命中时不写缓存（null 缓存会让该歌单会话内永久
 *     打不开）。
 *   - 2-13：搜索翻页失败后 key 回退（重试不再命中缓存守卫空转）。
 *   - 2-14：聚合搜索跳过已达 maxPages 的音源；wy 音质补充分批（每批 5 个）；
 *     歌单翻页用 deduplicationList 去重（约束已放宽为 { id: string }）。
 *
 * 运行：node scripts/sim-gemini-round2-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  request: 'src/utils/request.js',
  controller: 'src/plugins/player/controller.ts',
  playerUtils: 'src/plugins/player/utils.ts',
  themes: 'src/theme/themes/index.ts',
  webdavSync: 'src/core/sync/webdavSync.ts',
  songlistDetail: 'src/screens/SonglistDetail/MusicList.tsx',
  metadataHelpers: 'ios/LxMusicMobile/LXEmbeddedMetadataHelpers.mm',
  kgSongList: 'src/utils/musicSdk/kg/songList.js',
  searchMusic: 'src/core/search/music.ts',
  searchSonglist: 'src/core/search/songlist.ts',
  songlistAction: 'src/store/search/songlist/action.ts',
  utils: 'src/utils/index.ts',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))

const structuralReasons = (files) => {
  const reasons = []

  // —— 4-7：Content-Type 带 charset 时也要走 JSON 序列化 ——
  if (!files.request.includes("contentType.startsWith('application/json')")) {
    reasons.push('4-7：request.js 的 JSON 判定不是 startsWith（qs 带 charset 的 POST 会把 body 变成 "[object Object]"）')
  }
  if (/contentType\s*===\s*'application\/json'/.test(files.request)) {
    reasons.push('4-7：request.js 仍有严格相等 === \'application/json\' 的 Content-Type 判定')
  }

  // —— 2-2：定时退出只在 ended/终态分支 ——
  const exitCount = (files.controller.match(/handleExitApp\('Timeout Exit'\)/g) || []).length
  if (exitCount !== 3) {
    reasons.push(`2-2：controller.ts 的 handleExitApp('Timeout Exit') 有 ${exitCount} 处（应为 3：终态 + ended + trackChanged）`)
  }
  if (!files.controller.includes("if (event.state != 'paused' && global.lx.isPlayedStop) void handleExitApp('Timeout Exit')")) {
    reasons.push('2-2：终态（stopped/idle）分支缺少定时退出检查（paused 不是终态，不退）')
  }
  const endedAt = files.controller.indexOf("case 'ended':")
  const endedExitAt = files.controller.indexOf("if (global.lx.isPlayedStop) void handleExitApp('Timeout Exit')", endedAt)
  if (endedAt < 0 || endedExitAt < 0) {
    reasons.push('2-2：ended 分支缺少定时退出检查（播完当前曲目退出的主路径）')
  }

  // —— 5-2：深色激活态映射 c-1000 ——
  if (!files.themes.includes("activeTheme['c-primary-font-active'] = activeTheme['c-1000']")) {
    reasons.push('5-2：深色模式激活态文字没有映射为 c-1000（会回到 rgb(92,92,92) 近乎不可见）')
  }

  // —— 3-6：同步失败返回 false ——
  if (!files.webdavSync.includes('let succeeded = true')) reasons.push('3-6：triggerWebDAVSync 缺少 succeeded 跟踪变量')
  if (!files.webdavSync.includes('succeeded = false')) reasons.push('3-6：triggerWebDAVSync 的 catch 里没有把 succeeded 置 false')
  if (!files.webdavSync.includes('return succeeded')) reasons.push('3-6：triggerWebDAVSync 没有返回 succeeded（失败仍报成功）')

  // —— 2-3：占位音轨过滤用 isTempId ——
  if (!files.playerUtils.includes('export const isTempId')) reasons.push('2-3：player/utils.ts 缺少 isTempId 导出')
  if (!files.controller.includes('isTempId(global.lx.playerTrackId)')) {
    reasons.push('2-3：controller.ts 的占位音轨过滤没有用 isTempId')
  }

  // —— 5-1：搜索守卫 + 最终写回守卫 ——
  // S-12：搜索守卫不再是单行 return，改为 if 块内按 id 合并后 return；
  // 锚点只钉守卫条件本身（if (searchText.trim()) {），不钉块内实现。
  if (!files.songlistDetail.includes('if (searchText.trim()) {')) {
    reasons.push('5-1：handleListUpdate 缺少搜索守卫（过滤列表会写回全局 store）')
  }
  // S-15：id/source 守卫字符串在文件里出现两次（:150 进度回调旧有守卫与
  // :167 本批新增的最终写回守卫），includes() 只能证明至少有一处，
  // 删掉新增的 :167 仍能通过；改计数 ==2 钉死两处都在（同 2-2 的计数写法）。
  const finalGuardCount = (files.songlistDetail.match(/if \(songlistState\.listDetailInfo\.id === id && songlistState\.listDetailInfo\.source === source\)/g) || []).length
  if (finalGuardCount !== 2) {
    reasons.push(`5-1：id/source 守卫有 ${finalGuardCount} 处（应为 2：进度回调 + 最终写回，删掉任一处都会把 A 的歌写进已属 B 的 store）`)
  }

  // —— 6-7：MP3 写标签句柄校验 + 分块拷贝 ——
  if (!files.metadataHelpers.includes('if (readFh == nil)')) reasons.push('6-7：LXWriteMP3Metadata 缺少读句柄 nil 校验')
  if (!files.metadataHelpers.includes('if (writeFh == nil)')) reasons.push('6-7：LXWriteMP3Metadata 缺少写句柄 nil 校验')
  if (!files.metadataHelpers.includes('if (headerSize > fileLength)')) reasons.push('6-7：LXWriteMP3Metadata 缺少 headerSize 越界中止')
  if (!files.metadataHelpers.includes('256 * 1024')) reasons.push('6-7：LXWriteMP3Metadata 不是 256KB 分块流式拷贝')
  if (files.metadataHelpers.includes('readDataToEndOfFile')) {
    reasons.push('6-7：LXEmbeddedMetadataHelpers.mm 仍有 readDataToEndOfFile 整读调用')
  }

  // —— 4-21：kg 歌单正则未命中不写缓存 ——
  if (!files.kgSongList.includes('if (result) this.cache.set(chain, result)')) {
    reasons.push('4-21：kg songList 在正则未命中时仍写缓存（null 缓存污染）')
  }

  // —— 2-13：翻页失败 key 回退 ——
  if (!files.searchMusic.includes('listInfo.key = page > 1 ? `${page - 1}__${text}` : null')) {
    reasons.push('2-13：音乐搜索翻页失败后没有回退 key（重试命中缓存守卫空转）')
  }
  if (!files.searchSonglist.includes('listInfo.key = page > 1 ? `${page - 1}__${sourceId}__${text}` : null')) {
    reasons.push('2-13：歌单搜索翻页失败后没有回退 key')
  }

  // —— 2-14：聚合跳过已翻完音源 + wy 补充分批 + 歌单翻页去重 ——
  if (!files.searchMusic.includes("if (source == 'all' || (page > 1 && page > searchMusicState.maxPages[source]!)) continue")) {
    reasons.push('2-14(a)：聚合搜索没有跳过已达 maxPages 的音源')
  }
  if (!files.searchMusic.includes('i += 5') || !files.searchMusic.includes('needsSupplement.slice(i, i + 5)')) {
    reasons.push('2-14(b)：wy 音质补充没有按每批 5 个分批（会一页 30 个并发详情请求）')
  }
  if (!files.songlistAction.includes('deduplicationList(list)')) {
    reasons.push('2-14(c)：歌单翻页拼接没有用 deduplicationList 去重')
  }
  if (!files.utils.includes('deduplicationList = <T extends { id: string }>')) {
    reasons.push('2-14(c)：deduplicationList 的泛型约束不是 { id: string }（歌单条目无法直接用）')
  }

  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型（复刻关键纯逻辑）
// ---------------------------------------------------------------------------
const models = []

// —— 模型1：4-7 的 Content-Type 判定 ——
{
  const isJson = (ct) => typeof ct === 'string' && ct.startsWith('application/json')
  const ok = isJson('application/json') && isJson('application/json; charset=utf-8') &&
    !isJson('text/plain') && !isJson(undefined)
  models.push(['4-7：带 charset 的 application/json 也走 JSON 序列化', ok])
}

// —— 模型2：2-2 的退出时机 ——
{
  // 终态（stopped/idle）+ ended 才退；loading/buffering/playing/paused 不退
  const shouldExit = (state, isPlayedStop) =>
    isPlayedStop && (state === 'ended' || state === 'stopped' || state === 'idle')
  const ok = shouldExit('ended', true) && shouldExit('stopped', true) && shouldExit('idle', true) &&
    !shouldExit('paused', true) && !shouldExit('playing', true) && !shouldExit('loading', true) &&
    !shouldExit('ended', false)
  models.push(['2-2：只有 ended/stopped/idle 且定时到期才退 App', ok])
}

// —— 模型3：2-13 的 key 回退 ——
{
  const rollbackKey = (page, text) => page > 1 ? `${page - 1}__${text}` : null
  const ok = rollbackKey(3, '周杰伦') === '2__周杰伦' && rollbackKey(2, 'x') === '1__x' && rollbackKey(1, 'x') === null
  models.push(['2-13：翻页失败回退上一页 key，第 1 页失败置 null', ok])
}

// —— 模型4：2-14(b) 的分批 ——
{
  const batches = []
  const items = Array.from({ length: 12 }, (_, i) => i)
  for (let i = 0; i < items.length; i += 5) batches.push(items.slice(i, i + 5))
  const ok = batches.length === 3 && batches[0].length === 5 && batches[2].length === 2 &&
    batches.flat().join(',') === items.join(',')
  models.push(['2-14(b)：wy 补充分批每批 5 个、顺序不变', ok])
}

// —— 模型5：6-7 的分块拷贝 ——
{
  // 256KB 分块：总字节数不变，块数 = ceil(total / 256K)
  const chunkedCopy = (total) => {
    let remaining = total
    let chunks = 0
    let copied = 0
    while (remaining > 0) {
      const size = remaining > 256 * 1024 ? 256 * 1024 : remaining
      copied += size
      remaining -= size
      chunks++
    }
    return { chunks, copied }
  }
  const a = chunkedCopy(1024 * 1024)
  const b = chunkedCopy(100)
  const ok = a.chunks === 4 && a.copied === 1024 * 1024 && b.chunks === 1 && b.copied === 100
  models.push(['6-7：256KB 分块拷贝字节数与原文件一致', ok])
}

const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const cases = []
{
  const tampered = {
    ...REAL,
    request: REAL.request.replace("contentType.startsWith('application/json')", "contentType === 'application/json'"),
  }
  cases.push(['4-7 回退为严格相等判定', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    controller: REAL.controller.replace("if (event.state != 'paused' && global.lx.isPlayedStop) void handleExitApp('Timeout Exit')", ''),
  }
  cases.push(['2-2 终态退出检查被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    themes: REAL.themes.replace("activeTheme['c-primary-font-active'] = activeTheme['c-1000']", "activeTheme['c-primary-font-active'] = activeTheme['c-000']"),
  }
  cases.push(['5-2 深色激活态改回 c-000', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    webdavSync: REAL.webdavSync.replace('return succeeded', 'return true'),
  }
  cases.push(['3-6 同步失败又无条件返回 true', structuralReasons(tampered).length > 0])
}
{
  // S-12：搜索守卫已改为 if 块形式，反例同步改锚新形式（旧单行字符串已不存在）
  const tampered = {
    ...REAL,
    songlistDetail: REAL.songlistDetail.replace('if (searchText.trim()) {', 'if (false) {'),
  }
  cases.push(['5-1 搜索守卫被删', structuralReasons(tampered).length > 0])
}
{
  // S-15：删掉 :167 新增的最终写回守卫（该字符串的第二处出现）时必须变红；
  // 旧 includes() 锚点在此反例下仍为绿，正是本条要修的宽松点。
  // 用 lastIndexOf 定位第二处（第一处 :150 是进度回调的旧有守卫，不动它）。
  const guard = 'if (songlistState.listDetailInfo.id === id && songlistState.listDetailInfo.source === source)'
  const lastAt = REAL.songlistDetail.lastIndexOf(guard)
  const tampered = {
    ...REAL,
    songlistDetail: lastAt < 0 ? REAL.songlistDetail : REAL.songlistDetail.slice(0, lastAt) + REAL.songlistDetail.slice(lastAt + guard.length),
  }
  cases.push(['5-1 最终写回守卫（:167 新增）被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    metadataHelpers: REAL.metadataHelpers.replace('if (readFh == nil) {', 'if (false) {'),
  }
  cases.push(['6-7 读句柄 nil 校验被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    kgSongList: REAL.kgSongList.replace('if (result) this.cache.set(chain, result)', 'this.cache.set(chain, result)'),
  }
  cases.push(['4-21 kg 又无条件写缓存', structuralReasons(tampered).length > 0])
}
{
  const tampered = {
    ...REAL,
    searchMusic: REAL.searchMusic.replace('listInfo.key = page > 1 ? `${page - 1}__${text}` : null', ''),
  }
  cases.push(['2-13 音乐搜索 key 回退被删', structuralReasons(tampered).length > 0])
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
