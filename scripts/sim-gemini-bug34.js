/**
 * sim-gemini-bug34.js
 *
 * Bug 34（部分真实）：download.ts 暂停/恢复状态机竞态。真实链是「恢复被吞」
 * （旧实例 catch 把 waiting 覆写回 paused）与「二次恢复真双跑」（旧实例 catch
 * 把新实例的 downloading 覆写回 paused，用户再点恢复即双跑）。
 *
 * 钉住的修复不变量：
 *   - processQueue 按 id 判重：peek 找第一个未在途的任务出队，不用 shift-then-skip
 *     （shift 已出队，跳过即丢任务）；在途重复项留在队列里。
 *   - resumeTask 入口与入队前两处都检查 activeTaskIds；入队前命中时翻回 paused。
 *   - runDownloadTask 的 paused 分支只在任务仍为 paused（或已删）时才写回，
 *     不覆写恢复在途的 waiting 与新实例的 downloading/completed/error。
 *
 * 运行：node scripts/sim-gemini-bug34.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { download: read('src/core/download.ts') }

const sliceFn = (code, startMark, endMark) => {
  const start = code.indexOf(startMark)
  const end = endMark ? code.indexOf(endMark, start) : code.length
  return start === -1 ? '' : code.slice(start, end === -1 ? code.length : end)
}

const structuralReasons = (files) => {
  const reasons = []
  const code = files.download
  // ① processQueue peek 判重
  if (!code.includes('while (activeTaskIds.size < concurrency && taskQueue.length > 0)')) {
    reasons.push('processQueue 没有按并发数泵送（while 条件被改）')
  }
  if (!code.includes('taskQueue.findIndex(t => !activeTaskIds.has(t.id))')) {
    reasons.push('processQueue 没有 peek 找第一个未在途任务（按 id 判重缺失）')
  }
  if (!code.includes('taskQueue.splice(idx, 1)')) {
    reasons.push('processQueue 没有 splice 出队 peek 到的任务')
  }
  if (!code.includes('if (idx === -1) return')) {
    reasons.push('processQueue 在全部在途时没有返回（会空转/误启动）')
  }
  const pumpBody = sliceFn(code, 'const processQueue = () => {', 'export const kickDownloadQueue')
  if (pumpBody.includes('taskQueue.shift()')) {
    reasons.push('processQueue 还在用 shift 出队（跳过在途任务即丢任务，应 peek）')
  }
  // ② resumeTask 两处在途检查
  const resumeBody = sliceFn(code, 'export const resumeTask', 'export const addTask')
  const activeChecks = (resumeBody.match(/activeTaskIds\.has\(task\.id\)/g) || []).length
  if (activeChecks < 2) {
    reasons.push(`resumeTask 的 activeTaskIds 检查只有 ${activeChecks} 处，应为 2 处（入口 + 入队前）`)
  }
  if (!resumeBody.includes("downloadActions.updateTask(task.id, { status: 'paused' })")) {
    reasons.push('resumeTask 入队前命中在途时未翻回 paused（会卡在 waiting 无人认领）')
  }
  if (!resumeBody.includes('if (fileComplete) resumeCompleteFiles.delete(task.id)')) {
    reasons.push('resumeTask 入队前命中在途时未清本调用登记的快路径记录')
  }
  // ③ paused 分支不覆写新状态
  if (!code.includes('const freshStatus = downloadState.tasks.find(t => t.id === task.id)?.status')) {
    reasons.push('runDownloadTask paused 分支未读最新状态（覆写守卫缺失）')
  }
  if (!code.includes("if (freshStatus === 'paused' || freshStatus === undefined)")) {
    reasons.push('runDownloadTask paused 分支未按 freshStatus 守卫写回（会吞恢复/覆写新实例）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型
const models = []
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// 泵送模型：peek 判重（与 processQueue 同逻辑）
{
  const pump = (queue, active, concurrency) => {
    const q = [...queue]
    const a = new Set(active)
    const started = []
    while (a.size < concurrency && q.length > 0) {
      const idx = q.findIndex(t => !a.has(t))
      if (idx === -1) break
      const t = q.splice(idx, 1)[0]
      a.add(t)
      started.push(t)
    }
    return { started, remaining: q }
  }
  const r1 = pump(['A', 'B'], ['A'], 3)
  models.push(['泵送：队头是在途重复项时跳过它启动后面的', eq(r1.started, ['B'])])
  models.push(['泵送：在途重复项留在队列里，不丢任务', eq(r1.remaining, ['A'])])
  const r2 = pump(['A'], ['A'], 3)
  models.push(['泵送：全部在途时一个都不启动', eq(r2.started, []) && eq(r2.remaining, ['A'])])
  const r3 = pump(['A', 'B', 'C'], [], 2)
  models.push(['泵送：无重复时按序启动到并发上限', eq(r3.started, ['A', 'B']) && eq(r3.remaining, ['C'])])
  // 反面：旧 shift-then-skip 会丢任务（队头在途被 shift 后跳过即丢失）
  const pumpShiftSkip = (queue, active, concurrency) => {
    const q = [...queue]
    const a = new Set(active)
    const started = []
    while (a.size < concurrency && q.length > 0) {
      const t = q.shift()
      if (a.has(t)) continue
      a.add(t)
      started.push(t)
    }
    return { started, remaining: q }
  }
  const r4 = pumpShiftSkip(['A', 'B'], ['A'], 3)
  models.push(['反面教材：shift-then-skip 会丢掉在途重复项 A', eq(r4.started, ['B']) && eq(r4.remaining, [])])
}
// paused 分支写回守卫模型（与 runDownloadTask 同逻辑）
{
  const shouldWritePaused = (freshStatus) => freshStatus === 'paused' || freshStatus === undefined
  models.push(['写回守卫：waiting（恢复在途）不覆写', shouldWritePaused('waiting') === false])
  models.push(['写回守卫：downloading（新实例）不覆写', shouldWritePaused('downloading') === false])
  models.push(['写回守卫：completed/error 不覆写', shouldWritePaused('completed') === false && shouldWritePaused('error') === false])
  models.push(['写回守卫：仍为 paused 时写回（重申）', shouldWritePaused('paused') === true])
  models.push(['写回守卫：任务已删时写回（updateTask 对缺失任务是 no-op）', shouldWritePaused(undefined) === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, download: REAL.download.replace('taskQueue.findIndex(t => !activeTaskIds.has(t.id))', 'taskQueue.findIndex(t => true)') }
  cases.push(['processQueue 丢了按 id 判重', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('if (taskQueue.some(t => t.id === task.id) || activeTaskIds.has(task.id))', 'if (taskQueue.some(t => t.id === task.id))') }
  cases.push(['resumeTask 入口丢了在途检查', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace("if (freshStatus === 'paused' || freshStatus === undefined)", 'if (true)') }
  cases.push(['paused 分支丢了写回守卫（恢复又会被吞）', structuralReasons(tampered).length > 0])
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
