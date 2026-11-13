/**
 * sim-download-tabs-contract.js
 *
 * 「下载并入本地与下载 + 幻影条目修复」契约（2026-11-12）。
 *
 * 背景（用户真机反馈，Build #158）：
 *   ① 本地与下载里同一首歌出现两条：一条下载任务记录报「文件不存在」，
 *      一条是磁盘上的真实文件。根因是旧 scanLibrary 无条件展示已完成任务，
 *      任务↔文件只按 filePath 全字符串对齐；路径只要差一点，就同时生成
 *      幻影任务条目与真实文件条目。
 *   ② 独立下载管理页太多余，用户要求并入「本地与下载」，页内用
 *      「本地 | 下载」双标签（照酷狗布局），下载标签分下载中/已完成。
 *   ③ 下载列表总量恒未知、不显示速度：旧进度回调只认 RNFS 的
 *      contentLength（分块传输时全程 -1/0，且会把已知的总量覆写回 0），
 *      速度用相邻回调瞬时差、首帧经常为空。
 *
 * 本脚本钉住的修复不变量：
 *   - 本地列表只由磁盘扫描生成条目；已完成任务只在完整路径命中扫到的
 *     文件时提供元信息，没扫到的记录不进本地列表、去下载标签已完成组。
 *   - 下载标签包含全部任务：未完成（等待/下载/暂停/失败）进「下载中」，
 *     已完成记录进「已完成」；带全部暂停/全部清空（只清未完成）。
 *   - 总量：GET contentLength 优先，其次 HEAD 探测，完成后以实际写入
 *     字节兜底；速度用 2 秒滑动窗口算（下载开始预置 written=0 起点采样，
 *     首回调即有速度，不再有 500ms 盲区），行里空速度显示 0 B/s。
 *   - 悬浮下载球改去本地与下载的下载标签（pendingAction + 事件双通道），
 *     独立 DownloadManager 屏幕注册/跳转全部下线。
 *
 * 运行：node scripts/sim-download-tabs-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  localPage: 'src/screens/Home/Views/LocalDownload/index.tsx',
  downloadTab: 'src/screens/Home/Views/LocalDownload/DownloadTab.tsx',
  listItem: 'src/screens/DownloadManager/ListItem.tsx',
  downloadCore: 'src/core/download.ts',
  downloadBall: 'src/components/DownloadBall/index.tsx',
  appEvent: 'src/event/appEvent.ts',
  pendingAction: 'src/core/pendingAction.ts',
  navigation: 'src/navigation/navigation.ts',
  registerScreens: 'src/navigation/registerScreens.tsx',
  screenNames: 'src/navigation/screenNames.ts',
  constant: 'src/config/constant.ts',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))
const OLD_SCREEN_FILES = [
  'src/screens/DownloadManager/index.tsx',
  'src/screens/DownloadManager/Header.tsx',
]

const structuralReasons = (files, oldScreenExists) => {
  const reasons = []

  // ① 本地列表扫描为准
  if (!files.localPage.includes('completedTaskByPath.get(file.path)')) {
    reasons.push('本地列表没有按完整路径把扫到的文件与已完成任务对齐')
  }
  if (/missing:\s*!seenPaths\.has\(task\.filePath\)/.test(files.localPage)) {
    reasons.push('本地列表又在无条件生成 missing 任务条目（幻影回归）')
  }
  if (/for \(const task of completedTasks\) \{\s*\n\s*const base/.test(files.localPage)) {
    reasons.push('本地列表又在遍历全部已完成任务生成条目（没扫到的记录会冒充本地歌曲）')
  }
  const tempGuardAt = files.localPage.indexOf("file.fileName.includes('.download.')")
  const taskMatchAt = files.localPage.indexOf('completedTaskByPath.get(file.path)')
  if (tempGuardAt < 0 || (taskMatchAt >= 0 && tempGuardAt > taskMatchAt)) {
    reasons.push('本地扫描没有在任务对齐前排除 *.download.* 临时文件')
  }

  // ② 双标签与下载分组
  if (!files.localPage.includes("useState<'local' | 'download'>('local')")) {
    reasons.push('本地与下载页缺少 local/download 标签状态')
  }
  if (!files.localPage.includes('<DownloadTab')) reasons.push('本地与下载页没有渲染下载标签')
  if (!files.downloadTab.includes("task.status !== 'completed'")) {
    reasons.push('下载标签没有把未完成任务分进「下载中」')
  }
  if (!files.downloadTab.includes("task.status === 'completed'")) {
    reasons.push('下载标签没有把已完成记录分进「已完成」')
  }
  for (const label of ['下载中', '已完成', '全部暂停', '全部清空']) {
    if (!files.downloadTab.includes(label)) reasons.push(`下载标签缺少「${label}」`)
  }
  if (!files.downloadTab.includes('pauseTask(task.id)')) reasons.push('全部暂停没有走 pauseTask')
  if (!files.downloadTab.includes('removeTask(task.id)')) reasons.push('全部清空/删除没有走 removeTask')
  if (!files.downloadTab.includes('fileMissing')) reasons.push('已完成分组没有标注文件不存在的记录')
  // 已完成组「清理记录」：只删文件已不存在的失效记录
  if (!files.downloadTab.includes('清理记录')) reasons.push('已完成分组缺少「清理记录」入口')
  if (!files.downloadTab.includes('handleCleanRecords')) reasons.push('清理记录没有处理函数')
  if (!files.downloadTab.includes('missingIds.has(task.id)')) {
    reasons.push('清理记录没有按 missingIds 圈定失效记录（可能误删有效记录）')
  }
  if (!files.downloadTab.includes("toast('没有需要清理的下载记录'")) {
    reasons.push('清理记录在无失效记录时没有给出提示')
  }

  // ③ 总量与速度
  if (!files.downloadCore.includes("method: 'HEAD'")) reasons.push('下载核心没有 HEAD 总量探测兜底')
  if (!files.downloadCore.includes("response.headers.get('content-length')")) {
    reasons.push('HEAD 探测没有读 content-length')
  }
  if (!files.downloadCore.includes('if (res.contentLength > 0) knownTotal = res.contentLength')) {
    reasons.push('GET contentLength 没有优先覆盖/保留总量（会被 -1/0 覆写回未知）')
  }
  if (!files.downloadCore.includes('progressSamples')) reasons.push('速度没有用滑动窗口计算')
  if (!files.downloadCore.includes('progressSamples.push({ time: Date.now(), written: 0 })')) {
    reasons.push('下载开始没有预置速度起点采样（500ms 内下完的歌速度恒为 0 B/s）')
  }
  if (files.downloadCore.includes('if (elapsed >= 500)')) {
    reasons.push('速度仍有 500ms 门（起点采样后应放宽到 elapsed > 0 即算）')
  }
  if (!files.downloadCore.includes('total: knownTotal > 0 ? knownTotal : downloadResult.bytesWritten')) {
    reasons.push('下载完成时没有用实际写入字节兜底总量')
  }
  if (!files.listItem.includes("task.progress.speed || '0 B/s'")) {
    reasons.push('下载行空速度时没有显示 0 B/s 兜底')
  }
  if (!files.listItem.includes('stat(initialTask.filePath)')) {
    reasons.push('已完成行没有 stat 磁盘文件大小兜底')
  }

  // ④ 下载球改向 + 旧独立页下线
  if (!files.downloadBall.includes("setPendingAction({ type: 'localDownloadTab', data: 'download' })")) {
    reasons.push('下载球没有预置切到下载标签的 pendingAction（页面未挂载时会丢切换）')
  }
  if (!files.downloadBall.includes("setNavActiveId('nav_local_download')")) {
    reasons.push('下载球没有切到本地与下载页')
  }
  if (!files.downloadBall.includes('show_local_download_tab()')) {
    reasons.push('下载球没有发切标签事件（页面已挂载时会丢切换）')
  }
  if (files.downloadBall.includes('pushDownloadManagerScreen')) {
    reasons.push('下载球又在跳独立下载管理页')
  }
  if (!files.appEvent.includes("this.emit('show_local_download_tab')")) {
    reasons.push('appEvent 缺少 show_local_download_tab 事件')
  }
  if (!files.pendingAction.includes("'localDownloadTab'")) {
    reasons.push('pendingAction 类型缺少 localDownloadTab')
  }
  if (files.navigation.includes('pushDownloadManagerScreen')) reasons.push('navigation 仍保留独立下载页跳转函数')
  if (files.registerScreens.includes('DOWNLOAD_MANAGER_SCREEN') || files.registerScreens.includes('DownloadManagerProvider')) {
    reasons.push('registerScreens 仍注册独立下载管理页')
  }
  if (files.screenNames.includes('DOWNLOAD_MANAGER_SCREEN')) reasons.push('screenNames 仍保留独立下载页名')
  if (files.constant.includes("DOWNLOAD_MANAGER = 'DOWNLOAD_MANAGER'")) reasons.push('COMPONENT_IDS 仍保留 DOWNLOAD_MANAGER')
  if (oldScreenExists) reasons.push('独立 DownloadManager 屏幕文件（index/Header）仍存在')

  return reasons
}

const realReasons = structuralReasons(REAL, OLD_SCREEN_FILES.some(rel => fs.existsSync(path.join(ROOT, rel))))

// ---------------------------------------------------------------------------
// 行为模型（复刻关键纯逻辑）
// ---------------------------------------------------------------------------
const models = []

// —— 模型1：本地列表只由扫描生成 ——
const buildLocalItems = (scannedFiles, completedTasks) => {
  const byPath = new Map(completedTasks.map(t => [t.filePath, t]))
  return scannedFiles
    .filter(f => !f.fileName.includes('.download.'))
    .map(f => {
      const task = byPath.get(f.path)
      return task ? { id: task.id, kind: 'task', path: f.path } : { id: `localdl_${f.path}`, kind: 'file', path: f.path }
    })
}
{
  const scanned = [
    { path: '/music/ゼロセンチメートル.flac', fileName: 'ゼロセンチメートル.flac' },
    { path: '/music/x.mp3', fileName: 'x.mp3' },
    { path: '/music/y.download.mp3', fileName: 'y.download.mp3' },
  ]
  // 幻影场景：任务记录的 filePath 与真实落盘路径对不上
  const tasks = [{ id: 'task-zero', filePath: '/music/ゼロセンチメートル.mp3' }]
  const items = buildLocalItems(scanned, tasks)
  const ok = items.length === 2 &&
    items.filter(i => i.path.includes('ゼロ')).length === 1 &&
    items.find(i => i.path.includes('ゼロ')).kind === 'file'
  // 路径对得上时用任务信息
  const matched = buildLocalItems(scanned, [{ id: 'task-x', filePath: '/music/x.mp3' }])
  const ok2 = matched.find(i => i.path.endsWith('x.mp3')).kind === 'task'
  models.push(['本地列表：没扫到的任务不显示、扫到的只出现一次、命中任务用任务信息', ok && ok2])
}

// —— 模型2：下载分组 ——
const groupTasks = (tasks) => ({
  active: tasks.filter(t => t.status !== 'completed'),
  completed: tasks.filter(t => t.status === 'completed'),
})
{
  const grouped = groupTasks([
    { status: 'waiting' }, { status: 'downloading' }, { status: 'paused' },
    { status: 'error' }, { status: 'completed' }, { status: 'completed' },
  ])
  models.push(['下载分组：未完成 4 条进下载中、已完成 2 条进已完成', grouped.active.length === 4 && grouped.completed.length === 2])
}

// —— 模型3：总量优先级与完成兜底 ——
const resolveLiveTotal = (getLength, headLength) => (getLength > 0 ? getLength : (headLength > 0 ? headLength : 0))
const resolveCompletedTotal = (knownTotal, bytesWritten) => (knownTotal > 0 ? knownTotal : bytesWritten)
{
  const ok = resolveLiveTotal(-1, 1200) === 1200 &&
    resolveLiveTotal(3400, 1200) === 3400 &&
    resolveLiveTotal(0, 0) === 0 &&
    resolveCompletedTotal(0, 9876) === 9876 &&
    resolveCompletedTotal(5000, 9876) === 5000
  models.push(['总量：GET 优先、HEAD 兜底、完成时实际字节兜底', ok])
}

// —— 模型4：滑动窗口速度（起点采样后首回调即有速度） ——
const windowSpeed = (samples) => {
  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsed = last.time - first.time
  return elapsed > 0 ? (last.written - first.written) / (elapsed / 1000) : null
}
{
  const ok = windowSpeed([{ time: 0, written: 0 }, { time: 500, written: 500000 }]) === 1000000 &&
    // 起点采样 + 首回调 250ms：此前返回 null（窗口不足沿用旧值），现在已有平均速度
    windowSpeed([{ time: 0, written: 0 }, { time: 250, written: 100 }]) === 400 &&
    // 400ms 内下完的快歌：首回调即非零，不再全程 0 B/s
    windowSpeed([{ time: 0, written: 0 }, { time: 400, written: 4000000 }]) === 10000000 &&
    // 同一毫秒两次回调：elapsed 为 0，沿用旧值（防除零）
    windowSpeed([{ time: 100, written: 0 }, { time: 100, written: 50 }]) === null
  models.push(['速度：2 秒窗口内按字节增量算、起点采样使首回调即有速度、同一毫秒沿用旧值', ok])
}

// —— 模型5：清理记录只删失效记录 ——
const selectStaleRecords = (completedTasks, missingIds) => completedTasks.filter(t => missingIds.has(t.id))
{
  const completed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const stale = selectStaleRecords(completed, new Set(['b']))
  const noneStale = selectStaleRecords(completed, new Set())
  const ok = stale.length === 1 && stale[0].id === 'b' && noneStale.length === 0
  models.push(['清理记录：只圈定文件已不存在的已完成记录、文件还在的一条不动', ok])
}

const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检：把历史缺陷塞回源码，必须全部被拦下
// ---------------------------------------------------------------------------
const cases = []
{
  const tampered = {
    ...REAL,
    localPage: REAL.localPage.replace('completedTaskByPath.get(file.path)', 'undefined'),
  }
  cases.push(['本地扫描不再按路径对齐任务', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    localPage: `${REAL.localPage}\n// missing: !seenPaths.has(task.filePath)`,
  }
  cases.push(['幻影 missing 条目回归', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadCore: REAL.downloadCore.replace("method: 'HEAD'", "method: 'GET'"),
  }
  cases.push(['HEAD 总量探测被改回 GET', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadCore: REAL.downloadCore.replace('progressSamples.push({ time: Date.now(), written: 0 })', '// seed removed'),
  }
  cases.push(['速度起点采样被删（0 B/s 回归）', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadCore: REAL.downloadCore.replace('if (elapsed > 0) {', 'if (elapsed >= 500) {'),
  }
  cases.push(['速度 500ms 门回归', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadBall: `${REAL.downloadBall}\npushDownloadManagerScreen`,
  }
  cases.push(['下载球又跳独立页', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadTab: REAL.downloadTab.replaceAll('清理记录', '清理'),
  }
  cases.push(['已完成组「清理记录」入口被删', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = {
    ...REAL,
    downloadTab: REAL.downloadTab.replaceAll('missingIds.has(task.id)', 'true'),
  }
  cases.push(['清理记录不再按 missingIds 圈定（会误删有效记录）', structuralReasons(tampered, false).length > 0])
}
{
  cases.push(['独立屏幕文件复活', structuralReasons(REAL, true).length > 0])
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
