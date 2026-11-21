/**
 * sim-gemini-bug09.js
 *
 * Gemini Bug 9（部分真实）：Deeplink dataVerify min 校验方向写反 + 缺失 data
 * 抛 TypeError。
 *
 * 属实部分：min 判断把 min 当 max 用（String(val).length > rule.min 抛错）；
 * data 为 undefined 时 data[rule.key] 确实抛 TypeError，可达路径真实
 * （handleLinkAction 在 JSON 解析失败时 delete params.data）。
 *
 * 夸大部分：min 是死代码（全仓无调用方传 min）；TypeError 已被 runLinkAction
 * 的 try/catch 捕获并弹窗，不会崩溃——只是用户看到原始 TypeError 文案。
 *
 * 修法（src/core/init/deeplink/utils.js + musicAction.js）：
 *   min 判断方向改 <；dataVerify 开头加 data == null 时抛规范化错误；
 *   filterInfoByPlayMusic 的 switch 前判空。
 *
 * 运行：node scripts/sim-gemini-bug09.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const UTILS = 'src/core/init/deeplink/utils.js'
const MUSIC_ACTION = 'src/core/init/deeplink/musicAction.js'
const utilsSrc = fs.readFileSync(path.join(ROOT, UTILS), 'utf8').replace(/\r\n/g, '\n')
const musicActionSrc = fs.readFileSync(path.join(ROOT, MUSIC_ACTION), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 1500) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (utils, musicAction) => {
  const reasons = []
  const fn = windowBetween(utils, 'export const dataVerify = (rules, data) => {', '  return newData', 1500)
  if (!fn) {
    reasons.push('dataVerify 结构已变（找不到函数锚点）')
    return reasons
  }
  // ① data == null 抛规范化错误（在 data[rule.key] 之前）
  if (!/if \(data == null\) throw new Error\('data missing'\)/.test(fn)) {
    reasons.push('dataVerify 缺 data == null 规范化错误（会抛原始 TypeError）')
  }
  const nullGuardAt = fn.indexOf('if (data == null)')
  const dataReadAt = fn.indexOf('const val = data[rule.key]')
  if (nullGuardAt < 0 || dataReadAt < 0 || nullGuardAt > dataReadAt) {
    reasons.push('dataVerify 的判空没有排在 data[rule.key] 之前')
  }
  // ② min 判断方向
  if (!/if \(rule\.min && String\(val\)\.length < rule\.min\)/.test(fn)) {
    reasons.push('min 判断方向仍写反（应为 length < min 抛错）')
  }
  if (/String\(val\)\.length > rule\.min/.test(fn)) {
    reasons.push('仍有把 min 当 max 用的旧判断残留')
  }
  // max 方向不被误改
  if (!/if \(rule\.max && String\(val\)\.length > rule\.max\)/.test(fn)) {
    reasons.push('max 判断被误改（应为 length > max 抛错）')
  }

  // ③ filterInfoByPlayMusic switch 前判空
  const filterFn = windowBetween(musicAction, 'const filterInfoByPlayMusic = (musicInfo) => {', 'const handlePlayMusic')
  if (!/if \(musicInfo == null\) throw new Error\('musicInfo missing'\)/.test(filterFn)) {
    reasons.push('filterInfoByPlayMusic 的 switch 前缺判空（undefined 会抛原始 TypeError）')
  }
  const filterGuardAt = filterFn.indexOf('if (musicInfo == null)')
  const switchAt = filterFn.indexOf('switch (musicInfo.source)')
  if (filterGuardAt < 0 || switchAt < 0 || filterGuardAt > switchAt) {
    reasons.push('filterInfoByPlayMusic 的判空没有排在 switch 之前')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻 dataVerify + filterInfoByPlayMusic 判空
// ---------------------------------------------------------------------------
const dataVerify = (rules, data) => {
  if (data == null) throw new Error('data missing')
  const newData = {}
  for (const rule of rules) {
    const val = data[rule.key]
    if (rule.required && val == null) throw new Error(rule.key + ' missing')
    if (val != null) {
      if (rule.types && !rule.types.includes(typeof val)) { throw new Error(rule.key + ' type no match') }
      if (rule.max && String(val).length > rule.max) { throw new Error(rule.key + ' max length no match') }
      if (rule.min && String(val).length < rule.min) { throw new Error(rule.key + ' min length no match') }
    }
    newData[rule.key] = val
  }
  return newData
}
const filterInfoByPlayMusic = (musicInfo) => {
  if (musicInfo == null) throw new Error('musicInfo missing')
  switch (musicInfo.source) {
    case 'kw': return 'kw-ok'
    default: throw new Error('Unknown source: ' + musicInfo.source)
  }
}
const throwsWith = (fn, msg) => {
  try {
    fn()
    return false
  } catch (err) {
    return err.message === msg
  }
}

const models = []
models.push(['min 规则：长度不足抛错（"ab" min=3）',
  throwsWith(() => dataVerify([{ key: 'k', min: 3 }], { k: 'ab' }), 'k min length no match')])
models.push(['min 规则：长度足够通过（"abcd" min=3）',
  (() => { try { dataVerify([{ key: 'k', min: 3 }], { k: 'abcd' }); return true } catch { return false } })()])
models.push(['min 规则：旧方向会误杀长串——"abcdefgh" min=3 必须通过',
  (() => { try { dataVerify([{ key: 'k', min: 3 }], { k: 'abcdefgh' }); return true } catch { return false } })()])
models.push(['max 规则方向不变：超长抛错',
  throwsWith(() => dataVerify([{ key: 'k', max: 3 }], { k: 'abcd' }), 'k max length no match')])
models.push(['data 为 undefined：抛规范化错误 data missing（非 TypeError）',
  throwsWith(() => dataVerify([{ key: 'k' }], undefined), 'data missing')])
models.push(['data 为 null：抛规范化错误 data missing',
  throwsWith(() => dataVerify([{ key: 'k' }], null), 'data missing')])
models.push(['filterInfoByPlayMusic(undefined)：抛 musicInfo missing',
  throwsWith(() => filterInfoByPlayMusic(undefined), 'musicInfo missing')])
models.push(['filterInfoByPlayMusic 正常输入不受影响',
  filterInfoByPlayMusic({ source: 'kw' }) === 'kw-ok'])

const failedModels = models.filter(([, ok]) => !ok)

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.split(find).join(replace)
}
const cases = []
const checkCase = (name, utils, musicAction, expectSubstr) => {
  let reasons = []
  try {
    reasons = invariants(utils, musicAction)
  } catch (err) {
    cases.push([name, false, `抛异常: ${err.message}`])
    return
  }
  const hit = reasons.some((r) => r.includes(expectSubstr))
  cases.push([name, hit, hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）`])
}

checkCase('C1 min 方向改回 >',
  tamper(utilsSrc, 'if (rule.min && String(val).length < rule.min)', 'if (rule.min && String(val).length > rule.min)'),
  musicActionSrc,
  'min 判断方向仍写反')
checkCase('C2 dataVerify 去掉判空',
  tamper(utilsSrc, "  if (data == null) throw new Error('data missing')\n", ''),
  musicActionSrc,
  '缺 data == null')
checkCase('C3 filterInfoByPlayMusic 去掉判空',
  utilsSrc,
  tamper(musicActionSrc, "  if (musicInfo == null) throw new Error('musicInfo missing')\n", ''),
  'switch 前缺判空')

const missed = cases.filter(([, ok]) => !ok)

console.log('行为模型（deeplink 校验）')
for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('')
console.log('反例自检')
for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
console.log('')

let failed = 0
const realReasons = invariants(utilsSrc, musicActionSrc)
if (realReasons.length) {
  console.error(`FAIL  Bug 9 契约未通过（${realReasons.length} 项）：`)
  for (const r of realReasons) console.error(`        - ${r}`)
  failed += 1
}
if (failedModels.length) {
  console.error(`FAIL  行为模型未通过（${failedModels.length} 项）`)
  failed += 1
}
if (missed.length) {
  console.error(`FAIL  有反例未被拦下（${missed.length} 项，断言无区分力）`)
  failed += 1
}
if (!failed) {
  console.log(`PASS  Bug 9 契约通过（结构不变量 6 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
  process.exit(0)
}
process.exit(1)
