/**
 * sim-gemini-bug44.js
 *
 * Bug 44（真实，含同型项）：QQ 音乐搜索 tx/musicSearch.js 未对 body/meta 判空——
 * musicSearch 返回 body.req.data，data 缺失时解构本身即抛；body 缺失时取
 * item_song 抛；meta 缺失时取 estimate_sum 抛；整次搜索失败。
 * 同型：searchSinger（meta 缺失时 meta.estimate_sum || 0 仍抛）、searchAlbum
 * （body.item_album 未判空），一并修。
 *
 * 钉住的修复不变量：三处 search 函数的兜底都放在解构源头（data ?? {}、
 * body ?? {}、meta ?? {}）；search() 的 estimate_sum 用 || 0 兜底（否则 total
 * 为 undefined、allPage 为 NaN）。
 *
 * 运行：node scripts/sim-gemini-bug44.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { musicSearch: read('src/utils/musicSdk/tx/musicSearch.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.musicSearch
  const fallbacks = (code.match(/\?\? \{\}/g) || []).length
  if (fallbacks < 9) {
    reasons.push(`?? {} 兜底只有 ${fallbacks} 处，应至少 9 处（三函数各 3 处：data/body/meta）`)
  }
  if (code.includes('.then(({ body, meta })')) {
    reasons.push('仍有直接解构 ({ body, meta })（data 为 undefined 时解构本身即抛）')
  }
  if (code.includes('const { body, meta } = await this.musicSearch')) {
    reasons.push('searchAlbum 仍直接解构 await 结果（data 缺失时即抛）')
  }
  if (!code.includes('this.total = meta.estimate_sum || 0')) {
    reasons.push('search() 的 total 未用 || 0 兜底（meta 缺失时 total 为 undefined、allPage 为 NaN）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：解构源头兜底（与修复后代码同逻辑）
const models = []
const safeUnpack = (data) => {
  const { body: rawBody, meta: rawMeta } = data ?? {}
  const body = rawBody ?? {}
  const meta = rawMeta ?? {}
  return { body, meta }
}
{
  let threw = false
  let r
  try { r = safeUnpack(undefined) } catch { threw = true }
  models.push(['模型：data 为 undefined 时解构不抛错', threw === false && r.body && r.meta])
  models.push(['模型：data 为 null 时解构不抛错', (() => { try { safeUnpack(null); return true } catch { return false } })()])
  const r2 = safeUnpack({ body: null, meta: null })
  models.push(['模型：body/meta 为 null 时兜底为空对象', r2.body && typeof r2.body === 'object' && r2.meta && typeof r2.meta === 'object'])
  const r3 = safeUnpack({ body: { item_song: [1] }, meta: { estimate_sum: 42 } })
  models.push(['模型：正常数据原样通过', r3.body.item_song.length === 1 && r3.meta.estimate_sum === 42])
  // total 兜底：meta 缺失时 total 为 0、allPage 为 0（不是 undefined/NaN）
  const totals = (meta, limit) => {
    const total = meta.estimate_sum || 0
    return { total, allPage: Math.ceil(total / limit) }
  }
  const t = totals({}, 20)
  models.push(['模型：meta 缺失时 total=0、allPage=0（非 NaN）', t.total === 0 && t.allPage === 0])
  // 反面：旧直接解构在 data 缺失时抛 TypeError
  let oldThrew = false
  try { const { body } = undefined; void body } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧直接解构 undefined 抛 TypeError', oldThrew === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, musicSearch: REAL.musicSearch.replace('const { body: rawBody, meta: rawMeta } = data ?? {}', 'const { body, meta } = data') }
  cases.push(['search() 的解构源头兜底被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, musicSearch: REAL.musicSearch.replace('this.total = meta.estimate_sum || 0', 'this.total = meta.estimate_sum') }
  cases.push(['search() 的 total 兜底被删（meta 缺失时 total 为 undefined）', structuralReasons(tampered).length > 0])
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
