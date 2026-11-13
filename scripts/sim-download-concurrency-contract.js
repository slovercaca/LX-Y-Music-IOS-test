/**
 * sim-download-concurrency-contract.js
 *
 * 「下载多线程 + 失败策略下载侧」契约（2026-11-12）。
 *
 * 背景（用户需求）：
 *   ① 一次只能下一首太慢，允许用户自己设置下载队列并行量。
 *   ② 下载失败也走失败策略：取链三分支统一（wy Cookie / B 站直连失败后落到
 *      通用分支跑策略，不再直接删任务）；文件阶段失败重取一次新鲜 URL 再下一遍。
 *
 * 本脚本钉住的修复不变量：
 *   - worker 池：isProcessing 布尔门 + currentDownloadTask 单例已由
 *     activeTaskIds（泵送上限与排空判定）+ activeDownloadJobs（按任务查 jobId）取代。
 *   - 并发数读 download.concurrency，钳制 1–6，默认 3；调大后 UI 立即泵送。
 *   - 批量排空判定是「无入队中批次 + 队列空 + 在途为 0」，两处触发点共用同一函数。
 *   - 暂停/删除按任务 id 查它自己的 RNFS job（不碰其它在途任务）。
 *   - 取链三分支统一进 resolveTaskUrl；wy/bilibili 失败落通用分支，不删任务；
 *     取链失败不进文件重试循环（策略已跑过各步）。
 *   - 文件下载失败至多重取链再下一遍；暂停/取消不重试；改名/元数据只跑一次。
 *   - 换源成功写回 actualSource（与 actualQuality 同模式），列表行展示实际来源。
 *
 * 运行：node scripts/sim-download-concurrency-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  download: 'src/core/download.ts',
  defaultSetting: 'src/config/defaultSetting.ts',
  appSettingTypes: 'src/types/app_setting.d.ts',
  downloadTypes: 'src/types/download.d.ts',
  downloadIndex: 'src/screens/Home/Views/Setting/settings/Download/index.tsx',
  downloadConcurrency: 'src/screens/Home/Views/Setting/settings/Download/DownloadConcurrency.tsx',
  listItem: 'src/screens/DownloadManager/ListItem.tsx',
  langZh: 'src/lang/zh-cn.json',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))

// 去掉注释行再查（注释里提旧名字是交代，不算残留）
const stripComments = (text) => text.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

const structuralReasons = (files) => {
  const reasons = []
  const code = stripComments(files.download)

  // ① worker 池取代单线程门
  if (/let isProcessing/.test(code) || /let currentDownloadTask/.test(code)) {
    reasons.push('download.ts 还有 isProcessing / currentDownloadTask 单线程状态')
  }
  if (/\bcurrentDownloadTask\b/.test(code)) {
    reasons.push('download.ts 还有 currentDownloadTask 引用（应按任务查 job）')
  }
  if (!files.download.includes('const activeTaskIds = new Set<string>()')) {
    reasons.push('download.ts 缺少 activeTaskIds（泵送上限与排空判定）')
  }
  if (!files.download.includes('const activeDownloadJobs = new Map<string, any>()')) {
    reasons.push('download.ts 缺少 activeDownloadJobs（按任务查 RNFS job）')
  }
  if (!files.download.includes('const runDownloadTask = async(task: DownloadTask)')) {
    reasons.push('download.ts 缺少 runDownloadTask（单任务结算下移）')
  }
  if (!files.download.includes('while (activeTaskIds.size < concurrency && taskQueue.length > 0)')) {
    reasons.push('processQueue 没有按并发数泵送')
  }
  if (!files.download.includes('activeTaskIds.delete(task.id)')) {
    reasons.push('runDownloadTask finally 没有删 activeTaskIds（排空判定会永远等不到 0）')
  }
  if (!files.download.includes('export const kickDownloadQueue')) {
    reasons.push('download.ts 没有导出 kickDownloadQueue（调大并发后无法立即泵送）')
  }

  // ② 并发数钳制 1–6 默认 3
  if (!files.download.includes('Math.min(6, Math.max(1, n))')) {
    reasons.push('getDownloadConcurrency 没有钳制 1–6')
  }
  if (!files.defaultSetting.includes("'download.concurrency': 3")) {
    reasons.push('defaultSetting 缺少 download.concurrency 默认 3')
  }
  if (!files.appSettingTypes.includes("'download.concurrency': number")) {
    reasons.push('app_setting.d.ts 缺少 download.concurrency 类型')
  }
  if (!files.downloadConcurrency.includes('kickDownloadQueue()')) {
    reasons.push('并行数设置 UI 改完没有立即泵送队列')
  }
  if (!files.downloadIndex.includes('DownloadConcurrency')) {
    reasons.push('下载设置页没有渲染 DownloadConcurrency')
  }

  // ③ 批量排空判定共用同一函数
  if (!files.download.includes('const maybeReportBatchDrain = ()')) {
    reasons.push('download.ts 缺少 maybeReportBatchDrain（批量排空汇总）')
  }
  if (!files.download.includes('batchAddingCount !== 0 || taskQueue.length !== 0 || activeTaskIds.size !== 0')) {
    reasons.push('排空判定没有同时看入队计数、队列与在途数')
  }
  const drainCalls = (files.download.match(/maybeReportBatchDrain\(\)/g) || []).length
  if (drainCalls < 2) {
    reasons.push(`maybeReportBatchDrain 调用点只有 ${drainCalls} 处，应至少 2 处（runDownloadTask finally + batchDownload 补查）`)
  }

  // ④ 暂停/删除按任务查 job
  if (!files.download.includes('activeDownloadJobs.get(taskId)')) {
    reasons.push('pauseTask 没有按任务 id 查 RNFS job')
  }
  if (!files.download.includes('activeDownloadJobs.get(id)')) {
    reasons.push('removeTask 没有按任务 id 查 RNFS job')
  }
  if (!files.download.includes('activeDownloadJobs.set(task.id, downloadTask)')) {
    reasons.push('downloadOnce 没有按任务登记 RNFS job')
  }
  if (!files.download.includes('activeDownloadJobs.delete(task.id)')) {
    reasons.push('downloadOnce finally 没有注销 RNFS job')
  }

  // ⑤ 取链统一 + 落通用分支（不删任务）
  if (!files.download.includes('const resolveTaskUrl = async()')) {
    reasons.push('startDownload 缺少 resolveTaskUrl（取链三分支统一）')
  }
  if (!files.download.includes('改走通用取链（失败策略）')) {
    reasons.push('wy/bilibili 直连失败后没有落到通用分支跑失败策略')
  }
  // D-9：bilibili 直连拿到空 URL 也须抛错落通用分支（与 wy Cookie 分支同口径），
  // 否则空 URL 直接返回给下载器。
  if (!files.download.includes("if (!result.url) throw new Error('Bilibili 未能获取到URL')")) {
    reasons.push('bilibili 直连空 URL 没有抛错改走通用取链')
  }
  // 取链失败路径不删任务：startDownload 函数体内不应出现 removeTask（手动重试
  // retryTask 里的 removeTask(task.id) 是合法的——用户点重试时删旧任务重建）
  const startDownloadBody = (() => {
    const start = code.indexOf('const startDownload = async(task: DownloadTask)')
    const end = code.indexOf('const cacheDownloadedCover = async', start)
    return start === -1 || end === -1 ? '' : code.slice(start, end)
  })()
  if (/removeTask\(/.test(startDownloadBody)) {
    reasons.push('startDownload 里还在直接删任务（取链失败应标 error 保留任务）')
  }

  // ⑥ 文件阶段至多重试一次；暂停/取消不重试
  // 4-4：循环上限改为 (skipDownload ? 0 : 2)——恢复快路径（文件已完整）跳过
  // 下载循环，正常下载仍至多 2 次（第 2 次是文件失败后的重取链重试）
  if (!files.download.includes('for (let attempt = 0; attempt < (skipDownload ? 0 : 2); attempt++)')) {
    reasons.push('取链+下载没有包进至多 2 次的循环（文件失败应重取链再下一遍）')
  }
  if (!files.download.includes('const downloadOnce = async(')) {
    reasons.push('缺少 downloadOnce（单次文件下载闭包）')
  }
  // 暂停/取消直通守卫应有 3 处：wy 落通用分支前、bilibili 落通用分支前、文件重试循环内
  const pauseGuards = (files.download.match(/if \(pausedTaskIds\.has\(task\.id\) \|\| cancelledTaskIds\.has\(task\.id\)\) throw error/g) || []).length
  if (pauseGuards < 3) {
    reasons.push(`暂停/取消直通守卫只有 ${pauseGuards} 处，应为 3 处（wy/bilibili 落分支前 + 文件重试循环内）`)
  }

  // ⑦ 实际来源写回 + 列表展示
  if (!files.downloadTypes.includes('actualSource?: LX.OnlineSource')) {
    reasons.push('DownloadTask 类型缺少 actualSource')
  }
  if (!files.download.includes('writeBack.actualSource = resolved.resolvedMusicInfo.source')) {
    reasons.push('startDownload 没有写回实际来源（换源成功静默丢失）')
  }
  // 成功后按本次解析重申写回：第一遍换源/降级后下载失败、第二遍没换源却成功时，
  // 第一遍写回的 actualSource/actualQuality 是脏的，必须清掉
  if (!files.download.includes('actualSource: resolved.resolvedMusicInfo.source && resolved.resolvedMusicInfo.source !== task.musicInfo.source ? resolved.resolvedMusicInfo.source as LX.OnlineSource : undefined')) {
    reasons.push('下载成功后没有按本次解析重申 actualSource（重试后来源会标错）')
  }
  if (!files.listItem.includes('task.actualSource')) {
    reasons.push('下载列表行没有展示实际来源')
  }
  // ⑨ 上一遍的 HEAD 探测晚到时不得污染本遍总量
  if (!files.download.includes('if (url !== currentDownloadUrl) return')) {
    reasons.push('HEAD 探测没有按当前 URL 拦过期结果（重试后总量会算错）')
  }

  // ⑧ 文案
  for (const key of ['setting_download_concurrency', 'setting_download_concurrency_tip', 'setting_download_concurrency_n']) {
    if (!files.langZh.includes(`"${key}"`)) reasons.push(`zh-cn.json 缺少文案键 ${key}`)
  }

  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型
const models = []
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 并发数钳制（与 getDownloadConcurrency 同逻辑）
const clampConcurrency = (raw) => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 3
  return Math.min(6, Math.max(1, n))
}
models.push(['并发钳制：非法值回退 3', clampConcurrency(undefined) === 3 && clampConcurrency('x') === 3 && clampConcurrency(NaN) === 3])
models.push(['并发钳制：0 → 1，9 → 6，2.7 → 2', clampConcurrency(0) === 1 && clampConcurrency(9) === 6 && clampConcurrency(2.7) === 2])
models.push(['并发钳制：1 和 6 保持', clampConcurrency(1) === 1 && clampConcurrency(6) === 6])

// 泵送模型：队列 7 个任务，并发 3，逐个完成——同时在途永不超过 3，且全部跑完
{
  const queue = [1, 2, 3, 4, 5, 6, 7]
  const active = new Set()
  const done = []
  let maxActive = 0
  const pump = () => {
    while (active.size < 3 && queue.length > 0) active.add(queue.shift())
    maxActive = Math.max(maxActive, active.size)
  }
  pump()
  while (active.size > 0) {
    const first = [...active][0]
    active.delete(first)
    done.push(first)
    pump()
  }
  models.push(['泵送：并发 3 时在途永不超过 3', maxActive === 3])
  models.push(['泵送：7 个任务全部跑完且不丢不重', eq(done.sort(), [1, 2, 3, 4, 5, 6, 7])])
}
// 泵送模型：并发 1 = 旧串行行为
{
  const queue = [1, 2, 3]
  const active = new Set()
  let maxActive = 0
  const pump = () => {
    while (active.size < 1 && queue.length > 0) active.add(queue.shift())
    maxActive = Math.max(maxActive, active.size)
  }
  pump()
  while (active.size > 0) { active.delete([...active][0]); pump() }
  models.push(['泵送：并发 1 时严格串行', maxActive === 1])
}
// 排空模型
{
  const shouldDrain = (batchState, adding, queueLen, activeSize) => !!(batchState && adding === 0 && queueLen === 0 && activeSize === 0)
  models.push(['排空：三条件齐全才汇总', shouldDrain({}, 0, 0, 0) === true])
  models.push(['排空：还有在途任务不汇总', shouldDrain({}, 0, 0, 1) === false])
  models.push(['排空：还有排队任务不汇总', shouldDrain({}, 0, 2, 0) === false])
  models.push(['排空：还有批次在入队不汇总', shouldDrain({}, 1, 0, 0) === false])
}
// 文件重试模型：取链失败不重试、文件失败重试一次、暂停不重试
{
  const run = ({ resolveFails, fileFailsTimes, paused }) => {
    let resolves = 0
    let files = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      resolves++
      if (resolveFails) throw new Error('resolve failed')
      try {
        files++
        if (paused) throw new Error('paused')
        if (files <= fileFailsTimes) throw new Error('file failed')
        return { resolves, files, ok: true }
      } catch (e) {
        if (paused) throw e
        if (attempt === 1) throw e
      }
    }
    throw new Error('unreachable')
  }
  models.push(['重试：取链失败只解析一次（不重试）', (() => { try { run({ resolveFails: true, fileFailsTimes: 0, paused: false }) } catch { return true } return false })() && (() => { let n = 0; try { for (let a = 0; a < 2; a++) { n++; throw new Error('x') } } catch {} return n === 1 })()])
  models.push(['重试：文件失败一次后第二遍成功', (() => { const r = run({ resolveFails: false, fileFailsTimes: 1, paused: false }); return r.ok && r.resolves === 2 && r.files === 2 })()])
  models.push(['重试：文件连败两次后抛错', (() => { try { run({ resolveFails: false, fileFailsTimes: 2, paused: false }) } catch { return true } return false })()])
  models.push(['重试：暂停不重试', (() => { try { run({ resolveFails: false, fileFailsTimes: 0, paused: true }) } catch (e) { return e.message === 'paused' } return false })()])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, download: REAL.download.replace('activeTaskIds.delete(task.id)', '/* deleted */') }
  cases.push(['finally 丢了 activeTaskIds.delete', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('activeDownloadJobs.get(taskId)', 'activeDownloadJobs.get("x")') }
  cases.push(['pauseTask 不按任务查 job', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('batchAddingCount !== 0 || taskQueue.length !== 0 || activeTaskIds.size !== 0', 'taskQueue.length !== 0') }
  cases.push(['排空判定丢了在途数', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('for (let attempt = 0; attempt < (skipDownload ? 0 : 2); attempt++)', 'for (let attempt = 0; attempt < 1; attempt++)') }
  cases.push(['文件重试循环被改成只跑一次', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('if (pausedTaskIds.has(task.id) || cancelledTaskIds.has(task.id)) throw error', 'if (false) throw error') }
  cases.push(['文件重试循环丢了暂停检查', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, downloadConcurrency: REAL.downloadConcurrency.replace('kickDownloadQueue()', '/* no kick */') }
  cases.push(['调大并发后不再立即泵送', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace("if (!result.url) throw new Error('Bilibili 未能获取到URL')", '/* D-9 guard removed */') }
  cases.push(['D-9 bilibili 空 URL 守卫被删', structuralReasons(tampered).length > 0])
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
