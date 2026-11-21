/**
 * sim-gemini-bug37.js
 *
 * Bug 37（真实）：酷狗歌单重定向含 gcid_ 时误从原短链 link 提取——条件检查的是
 * 重定向目标 location，提取却对 link 做；短链本身通常不含 gcid_，gcid 恒为
 * undefined，decodeGcid 永远走不到，该类歌单无法打开。
 *
 * 钉住的修复不变量：重定向分支对 location 提取；无重定向分支（695-696 行）
 * 对 link 提取是对的，不要动。
 *
 * 运行：node scripts/sim-gemini-bug37.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { songList: read('src/utils/musicSdk/kg/songList.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.songList
  const locationExtracts = (code.match(/location\.match\(\/gcid_\\w\+\/\)/g) || []).length
  if (locationExtracts < 1) {
    reasons.push('重定向分支未对 location 提取 gcid（短链不含 gcid_ 时恒为 undefined）')
  }
  const linkExtracts = (code.match(/link\.match\(\/gcid_\\w\+\/\)/g) || []).length
  if (linkExtracts !== 1) {
    reasons.push(`对 link 提取 gcid 的有 ${linkExtracts} 处，应恰为 1 处（无重定向分支）`)
  }
  // 重定向分支的条件与提取必须在同一分支内对同一变量
  const redirectBranch = code.slice(code.indexOf("if (location.includes('gcid_'))"))
  if (!redirectBranch.startsWith("if (location.includes('gcid_')) {\n        let gcid = location.match(/gcid_\\w+/)?.[0]")) {
    reasons.push('重定向分支内条件查 location、提取却不是 location')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：gcid 提取（与修复后代码同逻辑）
const models = []
const extractFromRedirect = (link, location) => {
  if (!location.includes('gcid_')) return null
  return location.match(/gcid_\w+/)?.[0] ?? null
}
models.push(['模型：短链无 gcid、重定向目标有时能提取', extractFromRedirect('https://t.kugou.com/abc', 'https://m.kugou.com/share/gcid_12345') === 'gcid_12345'])
models.push(['模型：重定向目标无 gcid 时返回 null', extractFromRedirect('https://t.kugou.com/abc', 'https://m.kugou.com/share/xyz') === null])
{
  // 反面：旧逻辑对 link 提取——短链不含 gcid_ 时恒为 undefined
  const extractOld = (link, location) => {
    if (!location.includes('gcid_')) return null
    return link.match(/gcid_\w+/)?.[0] ?? null
  }
  models.push(['反面教材：旧逻辑对 link 提取时恒为 null', extractOld('https://t.kugou.com/abc', 'https://m.kugou.com/share/gcid_12345') === null])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, songList: REAL.songList.replace('let gcid = location.match(/gcid_\\w+/)?.[0]', 'let gcid = link.match(/gcid_\\w+/)?.[0]') }
  cases.push(['重定向分支改回对 link 提取', structuralReasons(tampered).length > 0])
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
