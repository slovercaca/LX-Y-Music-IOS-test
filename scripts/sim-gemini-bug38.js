/**
 * sim-gemini-bug38.js
 *
 * Bug 38（真实）：酷我 getListDetailMusicListByBDList 重试成功后解构 undefined
 * 崩溃——递归重试返回的是已解析的最终结果对象（无 .body），外层再按 { body }
 * 解构得 undefined，取 .code 必抛；重试成功反而崩溃，重试失败倒能正常 reject。
 *
 * 钉住的修复不变量：try/catch 包裹 await，catch 中直接 return 递归结果，
 * 不再经过外层 { body } 解构。
 *
 * 运行：node scripts/sim-gemini-bug38.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { songList: read('src/utils/musicSdk/kw/songList.js') }

const sliceFn = (code, startMark, endMark) => {
  const start = code.indexOf(startMark)
  const end = code.indexOf(endMark, start)
  return start === -1 ? '' : code.slice(start, end === -1 ? code.length : end)
}

const structuralReasons = (files) => {
  const reasons = []
  const code = files.songList
  const fnBody = sliceFn(code, 'async getListDetailMusicListByBDList(id, source, page, tryNum = 0)', 'async getListDetailMusicListByBD(id, page)')
  if (!fnBody.includes('let response')) {
    reasons.push('getListDetailMusicListByBDList 未用 try/catch + 响应变量重构（仍是解构链）')
  }
  if (!fnBody.includes('} catch {')) {
    reasons.push('getListDetailMusicListByBDList 未用 try/catch 包裹 await')
  }
  if (!fnBody.includes('return this.getListDetailMusicListByBDList(id, source, page, ++tryNum)')) {
    reasons.push('getListDetailMusicListByBDList 的 catch 内未直接返回递归重试结果')
  }
  if (!fnBody.includes('const { body: listData } = response')) {
    reasons.push('getListDetailMusicListByBDList 未在 try/catch 之后对响应解构 body')
  }
  if (fnBody.includes('.promise.catch(')) {
    reasons.push('getListDetailMusicListByBDList 还有挂在解构链上的 .catch（重试结果会被二次解构）')
  }
  if (!fnBody.includes("if (tryNum > 2) return Promise.reject(new Error('try max num'))")) {
    reasons.push('getListDetailMusicListByBDList 的重试上限守卫缺失')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：重试成功直接返回最终结果（与修复后代码同逻辑）
const models = []
{
  // 模拟：首次请求失败、重试成功——修复后返回最终结果对象，不经过二次解构
  const fetchOnce = (attempt) => {
    if (attempt === 0) return Promise.reject(new Error('network fail'))
    return Promise.resolve({ body: { code: 200, data: { list: [1], pageSize: 30, total: 1 } } })
  }
  const getList = async(tryNum = 0) => {
    let response
    try {
      response = await fetchOnce(tryNum)
    } catch {
      if (tryNum > 2) return Promise.reject(new Error('try max num'))
      return getList(++tryNum)
    }
    const { body: listData } = response
    if (listData.code !== 200) return Promise.reject(new Error('failed'))
    return { list: listData.data.list, total: listData.data.total }
  }
  models.push(['模型：首次失败、重试成功时返回最终结果（待异步验证）', true])
  // 同步验证旧逻辑必崩：递归结果无 .body，外层解构得 undefined
  const oldFlow = () => {
    const retryResult = { list: [1], total: 1 }
    const { body: listData } = retryResult
    return listData.code
  }
  let oldThrew = false
  try { oldFlow() } catch { oldThrew = true }
  models.push(['反面教材：旧逻辑重试成功后解构 .code 必抛 TypeError', oldThrew === true])
  globalThis.__bug38AsyncCheck = getList().then(
    (r) => r && r.total === 1 && r.list.length === 1,
    () => false,
  )
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, songList: REAL.songList.replace('const { body: listData } = response', 'const listData = response') }
  cases.push(['解构源头被改错（listData 变成整个响应对象）', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, songList: REAL.songList.replace('return this.getListDetailMusicListByBDList(id, source, page, ++tryNum)', 'return this.getListDetailMusicListByBDList(id, source, page, tryNum)') }
  cases.push(['重试不再递增 tryNum（无限重试）', structuralReasons(tampered).length > 0])
}
const failedCases = cases.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
const finish = async() => {
  const asyncPass = await globalThis.__bug38AsyncCheck
  console.log('== 结构不变量 ==')
  if (realReasons.length === 0) console.log('  PASS 全部结构不变量成立')
  else for (const r of realReasons) console.log(`  FAIL ${r}`)

  console.log('== 行为模型 ==')
  for (const [name, pass] of models) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)
  console.log(`  ${asyncPass ? 'PASS' : 'FAIL'} 模型：首次失败、重试成功时返回最终结果`)

  console.log('== 反例自检（必须全部拦下） ==')
  for (const [name, pass] of cases) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

  const failed = realReasons.length + failedModels.length + failedCases.length + (asyncPass ? 0 : 1)
  console.log(failed === 0 ? '\n全部通过' : `\n共 ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}
void finish()
