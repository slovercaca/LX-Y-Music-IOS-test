/**
 * sim-gemini-bug47.js
 *
 * Bug 47（真实）：网易 Cookie 取链 data 为空时直接访问 data.fee 抛 TypeError——
 * body.data 为空数组时进入 !data?.url 分支，103 行 data.fee 抛错；且 TypeError
 * 文本不含 VIP/未能获取，落入无效重试分支，白白多发 3 次请求后以误导性的
 * try max num 收场。
 *
 * 钉住的修复不变量：fee 判断用 data?.fee，data 为空时自然落入「未能获取到播放链接」。
 *
 * 运行：node scripts/sim-gemini-bug47.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { apiCookie: read('src/utils/musicSdk/wy/api-cookie.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.apiCookie
  if (!code.includes('data?.fee === 1 || data?.fee === 4')) {
    reasons.push('fee 判断未用 data?.fee（data 为空时抛 TypeError）')
  }
  if (/[^?]data\.fee === 1/.test(code) || /[^?]data\.fee === 4/.test(code)) {
    reasons.push('还有裸读 data.fee')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：无 url 分支的错误分流（与修复后代码同逻辑）
const models = []
const classifyNoUrl = (data) => {
  if (data?.fee === 1 || data?.fee === 4) return 'VIP 歌曲或无版权，无法通过 Cookie 获取'
  return '未能获取到播放链接'
}
// catch 层：含 VIP/未能获取的错误早退放行，不重试
const shouldEarlyExit = (err) => err.message.includes('VIP') || err.message.includes('未能获取')
{
  models.push(['模型：data 为 undefined 时不抛错、走「未能获取到播放链接」', classifyNoUrl(undefined) === '未能获取到播放链接'])
  models.push(['模型：data 为 null 时同样走「未能获取」', classifyNoUrl(null) === '未能获取到播放链接'])
  models.push(['模型：fee=1 时走 VIP 分支', classifyNoUrl({ fee: 1 }) === 'VIP 歌曲或无版权，无法通过 Cookie 获取'])
  models.push(['模型：fee=4 时走 VIP 分支', classifyNoUrl({ fee: 4 }) === 'VIP 歌曲或无版权，无法通过 Cookie 获取'])
  models.push(['模型：fee=0 时走「未能获取」', classifyNoUrl({ fee: 0 }) === '未能获取到播放链接'])
  models.push(['模型：「未能获取」错误在 catch 层早退、不重试', shouldEarlyExit(new Error(classifyNoUrl(undefined))) === true])
  models.push(['模型：VIP 错误在 catch 层早退、不重试', shouldEarlyExit(new Error(classifyNoUrl({ fee: 1 }))) === true])
  // 反面：旧裸读在 data 为空时抛 TypeError，且文本不含 VIP/未能获取、落入无效重试
  let oldThrew = false
  try { const data = undefined; void (data.fee === 1 || data.fee === 4) } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧裸读 data.fee 在 data 为空时抛 TypeError', oldThrew === true])
  models.push(['反面教材：TypeError 文本不触发早退（会无效重试）', shouldEarlyExit(new TypeError("Cannot read properties of undefined (reading 'fee')")) === false])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, apiCookie: REAL.apiCookie.replace('data?.fee === 1 || data?.fee === 4', 'data.fee === 1 || data.fee === 4') }
  cases.push(['fee 判断的 ?. 被删', structuralReasons(tampered).length > 0])
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
