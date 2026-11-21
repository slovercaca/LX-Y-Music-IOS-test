/**
 * sim-gemini-bug42.js
 *
 * Bug 42（部分真实）：汽水音乐缺失 getMusicDetailPageUrl，调用端未判空——
 * shareMusic 本身无调用方，但同一模式存在于两条真实路径（两处
 * handleShowMusicSourceDetail「查看音源详情」，Mylist 版有真实调用方且无 catch），
 * 汽水歌曲点「查看音源详情」即抛未处理 rejection。
 *
 * 钉住的修复不变量：
 *   - qishui/index.js 补 getMusicDetailPageUrl，返回 ''（无稳定详情页 URL 方案）。
 *   - 三处调用点都用 ?.getMusicDetailPageUrl?.(...)（tools.ts shareMusic +
 *     两处 listAction handleShowMusicSourceDetail）。
 *
 * 运行：node scripts/sim-gemini-bug42.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = {
  qishui: read('src/utils/musicSdk/qishui/index.js'),
  tools: read('src/utils/tools.ts'),
  onlineListAction: read('src/components/OnlineList/listAction.ts'),
  mylistListAction: read('src/screens/Home/Views/Mylist/MusicList/listAction.ts'),
}

const structuralReasons = (files) => {
  const reasons = []
  if (!files.qishui.includes('getMusicDetailPageUrl() {')) {
    reasons.push('qishui/index.js 未补 getMusicDetailPageUrl（违反接口契约）')
  }
  if (!files.qishui.includes("return ''")) {
    reasons.push('qishui 的 getMusicDetailPageUrl 未返回空串')
  }
  if (!files.tools.includes('getMusicDetailPageUrl?.(')) {
    reasons.push('tools.ts shareMusic 调用 getMusicDetailPageUrl 时未加 ?.（qs 会抛 TypeError）')
  }
  if (!files.onlineListAction.includes('getMusicDetailPageUrl?.(')) {
    reasons.push('OnlineList/listAction.ts 的 handleShowMusicSourceDetail 未加 ?. 判空')
  }
  if (!files.mylistListAction.includes('getMusicDetailPageUrl?.(')) {
    reasons.push('Mylist/MusicList/listAction.ts 的 handleShowMusicSourceDetail 未加 ?. 判空')
  }
  // 裸调用（?. 只 guard 模块、方法本身无判空）不应残留
  for (const [name, code] of [['tools.ts', files.tools], ['OnlineList/listAction.ts', files.onlineListAction], ['Mylist/MusicList/listAction.ts', files.mylistListAction]]) {
    if (/\?\.getMusicDetailPageUrl\(/.test(code)) {
      reasons.push(`${name} 还有裸调用 getMusicDetailPageUrl(（?. 只 guard 了模块）`)
    }
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型
const models = []
{
  // qs 模块补方法后返回空串，调用点 !url 直接返回，不打开链接
  const qishui = { getMusicDetailPageUrl() { return '' } }
  const url = qishui.getMusicDetailPageUrl?.({})
  models.push(['模型：qs getMusicDetailPageUrl 返回空串', url === ''])
  models.push(['模型：空串时调用点直接返回（不打开链接）', !url])
  // 方法缺失时 ?. 调用得 undefined，不抛错
  const musicSdk = { qs: {} }
  let threw = false
  let url2
  try { url2 = musicSdk.qs?.getMusicDetailPageUrl?.({}) } catch { threw = true }
  models.push(['模型：方法缺失时 ?. 调用不抛错、得 undefined', threw === false && url2 === undefined])
  // 反面：旧裸调用在方法缺失时抛 TypeError
  let oldThrew = false
  try { musicSdk.qs?.getMusicDetailPageUrl({}) } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧裸调用在 qs 上抛 TypeError', oldThrew === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, qishui: REAL.qishui.replace('  getMusicDetailPageUrl() {\n    return \'\'\n  },\n', '') }
  cases.push(['qishui 的 getMusicDetailPageUrl 被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, tools: REAL.tools.replace('getMusicDetailPageUrl?.(', 'getMusicDetailPageUrl(') }
  cases.push(['tools.ts 的 ?. 判空被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, mylistListAction: REAL.mylistListAction.replace('getMusicDetailPageUrl?.(', 'getMusicDetailPageUrl(') }
  cases.push(['Mylist listAction 的 ?. 判空被删', structuralReasons(tampered).length > 0])
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
