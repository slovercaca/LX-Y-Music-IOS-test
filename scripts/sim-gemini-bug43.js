/**
 * sim-gemini-bug43.js
 *
 * Bug 43（真实）：bilibili.getPic 返回 { promise } 普通对象（无 .then），调用方
 * utils.ts 把返回值 as Promise<string> 后直接调 .then，对 bilibili 源必抛
 * `then is not a function`，封面获取失败。
 *
 * 钉住的修复不变量：
 *   - getPic 直接 return Promise.resolve(songInfo?.img || '')（契约 Promise<string>）。
 *   - getLyric 同为 { promise } 形状，但其契约本就接受请求对象，不要动。
 *
 * 运行：node scripts/sim-gemini-bug43.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { bilibili: read('src/utils/musicSdk/bilibili/index.js') }

const sliceFn = (code, startMark, endMark) => {
  const start = code.indexOf(startMark)
  const end = code.indexOf(endMark, start)
  return start === -1 ? '' : code.slice(start, end === -1 ? code.length : end)
}

const structuralReasons = (files) => {
  const reasons = []
  const code = files.bilibili
  const getPicBody = sliceFn(code, 'getPic(songInfo) {', 'getLyric(songInfo) {')
  if (!getPicBody.includes("return Promise.resolve(songInfo?.img || '')")) {
    reasons.push('bilibili getPic 未直接返回 Promise.resolve(img)（契约是 Promise<string>）')
  }
  if (getPicBody.includes('requestObj.promise')) {
    reasons.push('bilibili getPic 还在返回 { promise } 对象（调用方 .then 必抛）')
  }
  // getLyric 不动：仍为 { promise } 形状（其契约接受请求对象）
  const getLyricBody = sliceFn(code, 'getLyric(songInfo) {', 'getMusicDetailPageUrl(songInfo) {')
  if (!getLyricBody.includes('requestObj.promise = Promise.resolve({ lyric:')) {
    reasons.push('bilibili getLyric 被顺手改了（其契约接受请求对象，不应动）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型
const models = []
{
  const getPic = (songInfo) => Promise.resolve(songInfo?.img || '')
  const ret = getPic({ img: 'http://x/cover.jpg' })
  models.push(['模型：getPic 返回 thenable（调用方可直接 .then）', typeof ret.then === 'function'])
  globalThis.__bug43AsyncCheck = Promise.all([
    getPic({ img: 'http://x/cover.jpg' }).then((u) => u === 'http://x/cover.jpg'),
    getPic({}).then((u) => u === ''),
    getPic(null).then((u) => u === ''),
  ]).then((results) => results.every(Boolean))
  // 反面：旧 { promise } 对象无 .then，调用方必抛
  const oldRet = {}
  oldRet.promise = Promise.resolve('http://x/cover.jpg')
  let oldThrew = false
  try { oldRet.then(() => {}) } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧 { promise } 对象调 .then 抛 TypeError', oldThrew === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, bilibili: REAL.bilibili.replace("return Promise.resolve(songInfo?.img || '')", "const requestObj = {}\n    requestObj.promise = Promise.resolve(songInfo?.img || '')\n    return requestObj") }
  cases.push(['getPic 改回返回 { promise } 对象', structuralReasons(tampered).length > 0])
}
const failedCases = cases.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
const finish = async() => {
  const asyncPass = await globalThis.__bug43AsyncCheck
  console.log('== 结构不变量 ==')
  if (realReasons.length === 0) console.log('  PASS 全部结构不变量成立')
  else for (const r of realReasons) console.log(`  FAIL ${r}`)

  console.log('== 行为模型 ==')
  for (const [name, pass] of models) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)
  console.log(`  ${asyncPass ? 'PASS' : 'FAIL'} 模型：getPic 解析为 img，缺 img/空入参时解析为空串`)

  console.log('== 反例自检（必须全部拦下） ==')
  for (const [name, pass] of cases) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

  const failed = realReasons.length + failedModels.length + failedCases.length + (asyncPass ? 0 : 1)
  console.log(failed === 0 ? '\n全部通过' : `\n共 ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}
void finish()
