/**
 * sim-offline-list-cover.js
 *
 * 离线列表封面契约（2026-11-13）。
 *
 * 背景（真实 bug，用户报）：
 *   断网 + 离线模式下，歌单列表左侧小封面全是 LX 占位图，但封面文件
 *   实际存在。根因：列表封面查找 findLocalCachedPic（core/music/index.ts）
 *   只查任务 file:// picUrl、picture/ 旁路文件与本地库 picture/ 缓存，
 *   从不读音频内嵌封面；而播放链路 localPlay.getPicUrl 第 1 步就是读
 *   内嵌（readPic）。2026-10-22 之前下载的歌曲只有内嵌封面、没有
 *   picture/ 旁路文件，于是列表无封面。列表缺内嵌而播放链路（任务/
 *   本地分支）有内嵌是不对称的代码事实；不要把“播放有封面”一概归因
 *   于此（在线歌曲从歌单点播时播放与列表走同一条 findLocalCachedPic，
 *   迷你播放器封面也可能是在线时段解析后残留的）。
 *
 * M-1（2026-11-13 审查发现）：qs 列表行经 fetchCoverUrl 分发时在
 * getPicPath 之前就被截到 fetchQsCover（filePath:''，从不匹配下载任务、
 * 从不读内嵌），离线 qs 行恒无封面。离线 qs 改走 getPicPath（其 qs
 * 离线分支只读本地、现含内嵌回退），在线 qs 保持跨平台匹配不变。
 * 连带：离线时内存里残留的 http 封面地址视为无缓存，放行到本地查找，
 * 否则同一会话内先在线浏览、再断网打开列表时行封面被 stale http 顶掉。
 *
 * 本脚本钉住的不变量：
 *   - findLocalCachedPic 内必须调用 readPic（内嵌封面回退在位），且带
 *     .catch（否则首个无封面任务的 reject 会 abort 整个查找）。
 *   - readPic 调用必须在任务循环内、且在本地库 picture/ 回退之前
 *     （任务匹配到的音频优先读内嵌，读不到才走模板基名查 picture/）。
 *   - 内嵌结果非空时必须返回（return embedded）。
 *   - readPic 必须从 @/utils/localMediaMetadata 导入（与播放链路同源）。
 *   - 旁路文件检查仍在内嵌之前（existsFile 便宜、原生提取相对贵）。
 *   - fetchCoverUrl 的 qs 分发必须带离线门（离线 qs 走 getPicPath）。
 *   - 离线时 http 缓存地址视为不可用（getCachedCoverUrl 与 fetchCoverUrl
 *     都必须经过 isUsableCachedUrl 守卫）。
 *
 * 运行：node scripts/sim-offline-list-cover.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const INDEX = path.join(ROOT, 'src/core/music/index.ts')
const COVERURL = path.join(ROOT, 'src/core/music/coverUrl.ts')

let failures = 0
const check = (ok, msg) => {
  if (ok) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// 提取 findLocalCachedPic 函数体（从声明到下一个顶层 export/const 之前）
const extractFn = (src) => {
  const start = src.indexOf('const findLocalCachedPic')
  if (start < 0) return null
  const end = src.indexOf('\nexport const getMusicUrl', start)
  if (end < 0) return null
  return src.slice(start, end)
}

console.log('离线列表封面契约：')

const src = read(INDEX)
const coverSrc = read(COVERURL)

check(
  /import \{[^}]*\breadPic\b[^}]*\} from '@\/utils\/localMediaMetadata'/.test(src),
  'readPic 从 @/utils/localMediaMetadata 导入',
)

const fn = extractFn(src)
check(fn !== null, 'findLocalCachedPic 可解析')
if (fn) {
  check(/readPic\(task\.filePath\)/.test(fn), 'findLocalCachedPic 内调用 readPic(task.filePath)')
  check(/if \(embedded\) return embedded/.test(fn), '内嵌结果非空时返回')

  const readPicAt = fn.indexOf('readPic(task.filePath)')
  const libraryAt = fn.indexOf('findLibraryPicture(coverBaseForSong')
  check(
    readPicAt >= 0 && libraryAt > readPicAt,
    'readPic 在本地库 picture/ 回退之前',
  )

  const sidecarAt = fn.indexOf('findPictureForAudio(task.filePath)')
  check(
    sidecarAt >= 0 && sidecarAt < readPicAt,
    '旁路文件检查在内嵌提取之前（便宜的先查）',
  )

  // readPic 在任务循环内：位于 for (const task of downloadState.tasks) 之后、
  // 循环闭合之前（以「继续检查其他匹配的任务」注释为循环尾标记）
  const loopAt = fn.indexOf('for (const task of downloadState.tasks)')
  const loopTailAt = fn.indexOf('继续检查其他匹配的任务')
  check(
    loopAt >= 0 && loopAt < readPicAt && readPicAt < loopTailAt,
    'readPic 在任务循环内（只对匹配到的任务读内嵌）',
  )

  // S-2：readPic 必须带 .catch——删掉它之后，首个无封面任务的 reject 会
  // abort 整个 findLocalCachedPic（跳过后续任务与模板查找）
  check(/readPic\(task\.filePath\)\.catch\(/.test(fn), 'readPic 调用带 .catch（reject 不 abort 查找）')

  // 反例自检：去掉 readPic 调用的函数体必须通不过「调用在位」检查
  const stripped = fn.replace(/readPic\(task\.filePath\)/g, 'NOPE(task.filePath)')
  check(!/readPic\(task\.filePath\)/.test(stripped), '反例自检：删掉 readPic 调用时检查能发现')
}

// M-1：qs 离线分发与 stale http 缓存守卫（coverUrl.ts）
const fetchFn = (() => {
  const start = coverSrc.indexOf('export const fetchCoverUrl')
  if (start < 0) return null
  return coverSrc.slice(start)
})()
check(fetchFn !== null, 'fetchCoverUrl 可解析')
if (fetchFn) {
  check(
    /song\.source === 'qs' && settingState\.setting\['player\.offlineMode'\] !== true/.test(fetchFn) &&
    fetchFn.indexOf("song.source === 'qs'") < fetchFn.indexOf('return fetchQsCover'),
    'qs 分发带离线门（离线 qs 不走 fetchQsCover，改走 getPicPath）',
  )
  check(
    /isUsableCachedUrl\(cached\)/.test(fetchFn),
    'fetchCoverUrl 的 coverCache 命中经过 isUsableCachedUrl 守卫',
  )
}

const cachedFn = (() => {
  const start = coverSrc.indexOf('export const getCachedCoverUrl')
  if (start < 0) return null
  const end = coverSrc.indexOf('export const fetchCoverUrl', start)
  return end < 0 ? null : coverSrc.slice(start, end)
})()
check(cachedFn !== null, 'getCachedCoverUrl 可解析')
if (cachedFn) {
  const uses = (cachedFn.match(/isUsableCachedUrl\(cached\)/g) || []).length
  check(uses >= 2, `getCachedCoverUrl 的 qs/非 qs 两分支都经过守卫（${uses} 处）`)
}

check(
  /const isUsableCachedUrl[\s\S]*?offlineMode/.test(coverSrc) &&
  /!url\.startsWith\('http'\)/.test(coverSrc),
  'isUsableCachedUrl 定义：离线时 http 地址视为不可用',
)

if (failures > 0) {
  console.log(`共 ${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
