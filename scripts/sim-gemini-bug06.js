/**
 * sim-gemini-bug06.js
 *
 * Gemini Bug 6（真实）：initDownloadPath 后台异步迁移全量覆写 downloadState.tasks
 * 丢失并发变更。
 *
 * 成因：后台 void 任务三步各做一次读盘快照 → 改 filePath → saveDownloadTasks
 * 全量覆盖磁盘 → setTasks 全量替换内存，步骤间无锁、无版本号、无合并。
 * 迁移读盘后用户新增下载任务，迁移随后把不含新任务的旧快照全量写回，新任务
 * 从磁盘和 UI 同时消失；反向：迁移刚写好新路径，一次基于迁移前内存态的
 * 节流保存随后落地，把旧路径写回来。丢数据，中严重度。
 *
 * 修法（src/core/init/index.ts）：
 *   迁移循环只收集 Map<oldPath, newPath>，完成后基于最新 downloadState.tasks
 *   原位映射更新再落盘；三处写回点抽公共 helper applyPathMapping 共用；
 *   保留步骤 2 的 P0 语义（文件真实存在并移动成功才改写路径）与步骤 3 的
 *   修复语义；合并按 filePath 精确匹配。
 *
 * 运行：node scripts/sim-gemini-bug06.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/index.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 4000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []

  // ① helper 存在且以最新内存任务为基准
  const helper = windowBetween(src, 'const applyPathMapping = async(mapping: Map<string, string>): Promise<boolean> => {', '/**\n * 初始化下载目录：')
  if (!helper) {
    reasons.push('缺 applyPathMapping helper（三处写回点未收敛）')
    return reasons
  }
  if (!/let tasks = downloadState\.tasks/.test(helper)) {
    reasons.push('applyPathMapping 未以最新 downloadState.tasks 为基准')
  }
  if (!/tasks = await getDownloadTasks\(\)/.test(helper)) {
    reasons.push('applyPathMapping 缺内存为空时的读盘回退（启动加载超时/失败时迁移会空转）')
  }
  if (!/const next = mapping\.get\(task\.filePath\)/.test(helper)) {
    reasons.push('applyPathMapping 未按 filePath 精确匹配映射')
  }
  if (!/await saveDownloadTasks\(tasks\)/.test(helper) || !/downloadActions\.setTasks\(tasks\)/.test(helper)) {
    reasons.push('applyPathMapping 未落盘 + 同步内存')
  }

  // ② 旧的全量覆盖模式不得残留
  if (/setTasks\(await getDownloadTasks\(\)\)/.test(src)) {
    reasons.push('仍有 setTasks(await getDownloadTasks()) 全量覆盖（旧模式残留）')
  }
  // task.filePath 的直接赋值只允许在 helper 内出现一次
  const directWrites = (src.match(/task\.filePath = /g) || []).length
  if (directWrites !== 1) {
    reasons.push(`task.filePath 直接赋值出现 ${directWrites} 次，应只在 applyPathMapping 内 1 次（迁移循环只收映射）`)
  }

  // ③ 三处写回点都走 helper
  const step2 = windowBetween(src, '// 2) 迁移散落在 Documents 根目录的下载文件', '// 3) 修复已被旧版迁移写坏的任务路径')
  if (!/await applyPathMapping\(movedPaths\)/.test(step2)) {
    reasons.push('步骤 2 未走 applyPathMapping 写回')
  }
  if (/task\.filePath = /.test(step2)) {
    reasons.push('步骤 2 循环内仍直接改写任务路径（应只收集映射）')
  }
  const step3 = windowBetween(src, '// 3) 修复已被旧版迁移写坏的任务路径', '// 4) 统一本地库结构')
  if (!/repairMap\.set\(filePath, candidate\)/.test(step3)) {
    reasons.push('步骤 3 未收集 repairMap（仍直接改写或未修复）')
  }
  if (!/await applyPathMapping\(repairMap\)/.test(step3)) {
    reasons.push('步骤 3 未走 applyPathMapping 写回')
  }
  const step4 = windowBetween(src, '// 4) 统一本地库结构', 'Failed to migrate library structure', 4000)
  if (!/await applyPathMapping\(moved\)/.test(step4)) {
    reasons.push('步骤 4 未走 applyPathMapping 写回')
  }

  // ④ 步骤 2 的 P0 语义保留：只有文件真实存在并移动成功才记入映射
  const moveBlock = windowBetween(step2, 'if (await existsFile(filePath)) {', '} catch (moveErr)', 800)
  if (!/await moveFile\(filePath, targetPath\)/.test(moveBlock) || !/movedPaths\.set\(filePath, targetPath\)/.test(moveBlock)) {
    reasons.push('步骤 2 的 P0 语义丢失（存在性检查 + 移动成功后才记入映射）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻 applyPathMapping（内存基准 + 精确匹配 + 读盘回退）
// ---------------------------------------------------------------------------
const makeEnv = ({ memoryTasks, diskTasks }) => {
  const disk = { tasks: diskTasks.map((t) => ({ ...t })) }
  const memory = { tasks: memoryTasks.map((t) => ({ ...t })) }
  const saved = []
  const applyPathMapping = async(mapping) => {
    if (mapping.size === 0) return false
    let tasks = memory.tasks
    if (tasks.length === 0) {
      tasks = disk.tasks.map((t) => ({ ...t }))
      if (tasks.length === 0) return false
    }
    let changed = false
    for (const task of tasks) {
      if (!task.filePath) continue
      const next = mapping.get(task.filePath)
      if (next && next !== task.filePath) {
        task.filePath = next
        changed = true
      }
    }
    if (!changed) return false
    saved.push(tasks.map((t) => ({ ...t })))
    memory.tasks = tasks
    return true
  }
  return { disk, memory, saved, applyPathMapping }
}

const runModels = async() => {
  const models = []
  {
    // 报告的核心场景：迁移读盘后用户新增任务，写回不得丢新任务
    const env = makeEnv({
      memoryTasks: [
        { id: 'old', filePath: '/Docs/song.mp3' },
        { id: 'new', filePath: '/Docs/本地/new.mp3' }, // 迁移期间新增
      ],
      diskTasks: [{ id: 'old', filePath: '/Docs/song.mp3' }],
    })
    const mapping = new Map([['/Docs/song.mp3', '/Docs/本地/song.mp3']])
    const changed = await env.applyPathMapping(mapping)
    const mem = env.memory.tasks
    models.push(['迁移期间新增的任务不丢失，旧任务路径被映射',
      changed === true &&
      mem.find((t) => t.id === 'old')?.filePath === '/Docs/本地/song.mp3' &&
      mem.find((t) => t.id === 'new')?.filePath === '/Docs/本地/new.mp3' &&
      env.saved[0].length === 2])
  }
  {
    // 映射键精确匹配：同名不同目录的任务不受影响
    const env = makeEnv({
      memoryTasks: [
        { id: 'a', filePath: '/Docs/song.mp3' },
        { id: 'b', filePath: '/Docs/other/song.mp3' },
      ],
      diskTasks: [],
    })
    await env.applyPathMapping(new Map([['/Docs/song.mp3', '/Docs/本地/song.mp3']]))
    models.push(['按 filePath 精确匹配，同名不同目录的任务不被误改',
      env.memory.tasks.find((t) => t.id === 'a').filePath === '/Docs/本地/song.mp3' &&
      env.memory.tasks.find((t) => t.id === 'b').filePath === '/Docs/other/song.mp3'])
  }
  {
    // 内存为空（启动加载超时）时回退读盘
    const env = makeEnv({
      memoryTasks: [],
      diskTasks: [{ id: 'old', filePath: '/Docs/song.mp3' }],
    })
    const changed = await env.applyPathMapping(new Map([['/Docs/song.mp3', '/Docs/本地/song.mp3']]))
    models.push(['内存为空时回退读盘，磁盘任务仍被映射并写回',
      changed === true && env.memory.tasks[0].filePath === '/Docs/本地/song.mp3' && env.saved.length === 1])
  }
  {
    // 无匹配时不落盘、不触发 setTasks
    const env = makeEnv({
      memoryTasks: [{ id: 'a', filePath: '/Docs/本地/song.mp3' }],
      diskTasks: [],
    })
    const changed = await env.applyPathMapping(new Map([['/Docs/gone.mp3', '/Docs/本地/gone.mp3']]))
    models.push(['无任务匹配映射时不落盘（changed=false）', changed === false && env.saved.length === 0])
  }
  {
    // 映射为空时直接返回
    const env = makeEnv({
      memoryTasks: [{ id: 'a', filePath: '/Docs/song.mp3' }],
      diskTasks: [],
    })
    const changed = await env.applyPathMapping(new Map())
    models.push(['映射为空时不读盘不落盘', changed === false && env.saved.length === 0])
  }
  return models
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.split(find).join(replace)
}

const main = async() => {
  const models = await runModels()
  const failedModels = models.filter(([, ok]) => !ok)

  const cases = []
  const checkCase = (name, src, expectSubstr) => {
    let reasons = []
    try {
      reasons = invariants(src)
    } catch (err) {
      cases.push([name, false, `抛异常: ${err.message}`])
      return
    }
    const hit = reasons.some((r) => r.includes(expectSubstr))
    cases.push([name, hit, hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）`])
  }

  checkCase('C1 helper 改回读盘快照为基准',
    tamper(real, 'let tasks = downloadState.tasks', 'let tasks = await getDownloadTasks()'),
    '未以最新 downloadState.tasks 为基准')
  checkCase('C2 步骤 2 不走 helper（恢复旧的全量覆盖）',
    tamper(real, 'if (await applyPathMapping(movedPaths)) {', 'if (false) { // no write-back'),
    '步骤 2 未走 applyPathMapping')
  checkCase('C3 步骤 3 循环内直接改写任务路径',
    tamper(real, 'repairMap.set(filePath, candidate)', 'task.filePath = candidate'),
    '直接赋值出现')
  checkCase('C4 helper 去掉读盘回退',
    tamper(real, '    tasks = await getDownloadTasks()\n', ''),
    '缺内存为空时的读盘回退')

  const missed = cases.filter(([, ok]) => !ok)

  console.log('行为模型（路径映射合并）')
  for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('')
  console.log('反例自检')
  for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
  console.log('')

  let failed = 0
  const realReasons = invariants(real)
  if (realReasons.length) {
    console.error(`FAIL  Bug 6 契约未通过（${realReasons.length} 项）：`)
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
    console.log(`PASS  Bug 6 契约通过（结构不变量 10 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
    process.exit(0)
  }
  process.exit(1)
}

void main()
