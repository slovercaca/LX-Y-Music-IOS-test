/**
 * sim-gemini-bug18.js
 *
 * Bug 18（Gemini 全量审查 2026-11-21，核实：部分真实）：
 * src/utils/nativeModules/utils.ts 的 beginBackgroundTask 并发竞态。
 *
 * 机制：守卫在 await 之前，无 in-flight 标志，并发调用确实都会通过守卫并发起
 * 桥接调用。但原生侧 AppDelegate.mm 已去重：已有有效任务时直接复用同一 ID
 * 返回，两个并发 JS 调用在主队列串行执行，拿到的是同一个 ID，根本不会
 * "申请两个任务"，无句柄泄漏。另：该 JS 导出目前零调用方，竞态当前无法触发。
 * 真实存在的次要问题（报告未提）：begin 在途时先调 end → end 见
 * backgroundTaskId==null 直接返回，随后 begin 完成并持有任务，无人再 end。
 *
 * 修法（只做 JS 侧 in-flight Promise 复用 + 次要问题顺带处理）：
 *   - 并发 begin 复用同一个在途 Promise，只发一次桥接调用；
 *   - begin 在途时调 end：记下挂起请求，任务到手后立即释放；
 *   - 绝对不要按 Gemini 建议的"返回后若已存在 backgroundTaskId 则立即 end"修——
 *     并发返回的是同一个 ID，end 掉它等于杀掉唯一的共享任务，一半有害。
 *
 * 本脚本复刻修复后的 begin/end 逻辑（假 UtilsModule：原生去重 + 可控延迟），
 * 验证 8 个断言；另用内容锚点钉住真实源码（在途复用 + 挂起 end + 无有害修法）。
 *
 * 运行：node scripts/sim-gemini-bug18.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/utils/nativeModules/utils.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻修复后的 begin/end（与 utils.ts 逐行对应）
// 假原生层：begin 去重（已有任务返回同一 ID），end 释放；桥接调用可控延迟。
// ---------------------------------------------------------------------------

const makeModel = () => {
  let nativeTaskId = null // 原生侧当前任务（去重视图）
  let nextId = 1
  let beginCalls = 0
  let endCalls = 0
  const pendingBegins = [] // 在途桥接调用的 { resolve, reject } 队列
  const UtilsModule = {
    beginBackgroundTask: () => {
      beginCalls++
      return new Promise((resolve, reject) => { pendingBegins.push({ resolve, reject }) })
    },
    endBackgroundTask: (taskId) => {
      endCalls++
      if (nativeTaskId === taskId) nativeTaskId = null
    },
  }
  // 原生侧去重：已有任务则复用同一 ID，否则分配新 ID
  const resolveNextBegin = () => {
    const { resolve } = pendingBegins.shift()
    if (nativeTaskId == null) nativeTaskId = nextId++
    resolve(nativeTaskId)
  }
  const resolveNextBeginInvalid = () => {
    pendingBegins.shift().resolve(0) // 系统未分配后台时间
  }
  const rejectNextBegin = () => {
    pendingBegins.shift().reject(new Error('bridge fail'))
  }

  // ---- 复刻 utils.ts 的 JS 层状态与函数 ----
  let backgroundTaskId = null
  let beginBackgroundTaskPromise = null
  let endRequestedWhileBeginning = false

  const beginBackgroundTask = () => {
    if (backgroundTaskId != null) return Promise.resolve()
    if (beginBackgroundTaskPromise) return beginBackgroundTaskPromise
    beginBackgroundTaskPromise = (async() => {
      try {
        const taskId = await UtilsModule.beginBackgroundTask()
        if (typeof taskId == 'number' && taskId > 0) {
          if (endRequestedWhileBeginning) {
            try {
              UtilsModule.endBackgroundTask(taskId)
            } catch {}
          } else {
            backgroundTaskId = taskId
          }
        }
      } catch {}
    })().finally(() => {
      beginBackgroundTaskPromise = null
      endRequestedWhileBeginning = false
    })
    return beginBackgroundTaskPromise
  }

  const endBackgroundTask = () => {
    if (backgroundTaskId != null) {
      const taskId = backgroundTaskId
      backgroundTaskId = null
      try {
        UtilsModule.endBackgroundTask(taskId)
      } catch {}
      return
    }
    if (beginBackgroundTaskPromise) endRequestedWhileBeginning = true
  }

  return {
    beginBackgroundTask,
    endBackgroundTask,
    resolveNextBegin,
    resolveNextBeginInvalid,
    rejectNextBegin,
    get backgroundTaskId() { return backgroundTaskId },
    get nativeTaskId() { return nativeTaskId },
    get beginCalls() { return beginCalls },
    get endCalls() { return endCalls },
    get pendingCount() { return pendingBegins.length },
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const main = async() => {
  console.log('sim-gemini-bug18：beginBackgroundTask in-flight 复用 + 挂起 end\n')

  // 断言1（主修）：并发 begin 只发一次桥接调用，共享同一个在途 Promise
  {
    const m = makeModel()
    const p1 = m.beginBackgroundTask()
    const p2 = m.beginBackgroundTask()
    const p3 = m.beginBackgroundTask()
    check('并发 3 次 begin：只发 1 次桥接调用，且返回同一个 Promise',
      m.beginCalls === 1 && m.pendingCount === 1 && p1 === p2 && p2 === p3,
      `桥接调用=${m.beginCalls} 次，在途=${m.pendingCount} 个，同 Promise=${p1 === p2 && p2 === p3}`)
    m.resolveNextBegin()
    await p1; await p2; await p3
    await tick()
    check('并发 begin 完成后：JS 与原生各持有同一个任务 ID',
      m.backgroundTaskId !== null && m.backgroundTaskId === m.nativeTaskId,
      `JS=${m.backgroundTaskId}，原生=${m.nativeTaskId}`)
  }

  // 断言2（有害修法对照）：并发返回同一 ID 时绝不能 end 掉它——
  // 修复后共享任务存活（若按 Gemini 的 end-on-duplicate 修，任务会被杀掉）
  {
    const m = makeModel()
    m.beginBackgroundTask()
    m.beginBackgroundTask()
    m.resolveNextBegin()
    await tick(); await tick()
    check('并发返回同一 ID 后：任务仍存活，end 调用 0 次（有害修法会杀掉它）',
      m.nativeTaskId !== null && m.endCalls === 0,
      `原生任务=${m.nativeTaskId}，end 调用=${m.endCalls} 次`)
  }

  // 断言3（次要问题）：begin 在途时先调 end → 任务到手后立即释放，无人持有
  {
    const m = makeModel()
    const p = m.beginBackgroundTask()
    m.endBackgroundTask() // begin 在途，记下挂起请求
    m.resolveNextBegin() // 任务到手，应立即释放
    await p
    await tick()
    check('begin 在途时 end：任务到手后立即释放，JS/原生均无人持有',
      m.backgroundTaskId === null && m.nativeTaskId === null && m.endCalls === 1,
      `JS=${m.backgroundTaskId}，原生=${m.nativeTaskId}，end 调用=${m.endCalls} 次`)
  }

  // 断言4（挂起 end 不污染下一次 begin）：断言3之后再 begin，任务正常持有
  {
    const m = makeModel()
    const p1 = m.beginBackgroundTask()
    m.endBackgroundTask()
    m.resolveNextBegin()
    await p1
    await tick()
    const p2 = m.beginBackgroundTask() // 下一次 begin，挂起标记须已清零
    m.resolveNextBegin()
    await p2
    await tick()
    check('挂起 end 被消费后：下一次 begin 正常持有任务（不被误杀）',
      m.backgroundTaskId !== null && m.backgroundTaskId === m.nativeTaskId && m.endCalls === 1,
      `JS=${m.backgroundTaskId}，原生=${m.nativeTaskId}，end 调用=${m.endCalls} 次`)
  }

  // 断言5（正常 end 回归）：begin 完成后再 end，正常释放
  {
    const m = makeModel()
    const p = m.beginBackgroundTask()
    m.resolveNextBegin()
    await p
    await tick()
    m.endBackgroundTask()
    check('正常流程：begin 完成后再 end，任务释放',
      m.backgroundTaskId === null && m.nativeTaskId === null && m.endCalls === 1,
      `JS=${m.backgroundTaskId}，原生=${m.nativeTaskId}`)
  }

  // 断言6（系统未分配后台时间）：begin 返回 0 时不持有任务，下一次 begin 可重试
  {
    const m = makeModel()
    const p1 = m.beginBackgroundTask()
    m.resolveNextBeginInvalid() // taskId = 0
    await p1
    await tick()
    const heldNothing = m.backgroundTaskId === null
    const p2 = m.beginBackgroundTask()
    const retried = m.beginCalls === 2 // 在途 Promise 已清，可再次发起
    m.resolveNextBegin()
    await p2
    await tick()
    check('begin 返回 0：不持有任务，且在途 Promise 已清、可再次 begin',
      heldNothing && retried && m.backgroundTaskId !== null,
      `首次持有=${!heldNothing}，重试发起=${retried}，最终持有=${m.backgroundTaskId}`)
  }

  // 断言7（桥接失败路径）：begin 抛错时不持有任务，在途 Promise 已清可重试
  {
    const m = makeModel()
    const p1 = m.beginBackgroundTask()
    m.rejectNextBegin() // 桥接抛错，catch 吞掉
    await p1 // 修复后 begin 永不 reject（内部 try/catch）
    await tick()
    const heldNothing = m.backgroundTaskId === null
    const p2 = m.beginBackgroundTask()
    const retried = m.beginCalls === 2
    m.resolveNextBegin()
    await p2
    await tick()
    check('begin 抛错：不持有任务，在途 Promise 已清、可再次 begin 且成功持有',
      heldNothing && retried && m.backgroundTaskId !== null,
      `首次持有=${!heldNothing}，重试发起=${retried}，最终持有=${m.backgroundTaskId}`)
  }

  // 断言8（内容锚点）：真实源码里在途复用 + 挂起 end 都在，且无有害的 end-on-duplicate
  {
    const beginFn = SRC.slice(
      SRC.indexOf('export const beginBackgroundTask'),
      SRC.indexOf('export const endBackgroundTask'),
    )
    const hasInflight = beginFn.includes('if (beginBackgroundTaskPromise) return beginBackgroundTaskPromise')
    const hasPendingEnd = beginFn.includes('if (endRequestedWhileBeginning)')
    const hasFinallyClear = beginFn.includes('beginBackgroundTaskPromise = null') &&
      beginFn.includes('endRequestedWhileBeginning = false')
    // 有害修法 = begin 返回后"见已有 backgroundTaskId 就 end 掉新 ID"；
    // 修复后的 begin 内有且仅有一处 end 调用，且位于 endRequestedWhileBeginning 分支内。
    const endCallCount = (beginFn.match(/UtilsModule\.endBackgroundTask\(/g) || []).length
    const beginEndIdx = beginFn.indexOf('UtilsModule.endBackgroundTask(taskId)')
    const pendingIfIdx = beginFn.indexOf('if (endRequestedWhileBeginning)')
    const endGatedByPending = endCallCount === 1 && beginEndIdx > pendingIfIdx && pendingIfIdx > 0
    check('源码锚点：在途复用 + 挂起 end + finally 清理都在；begin 内唯一 end 由挂起请求触发',
      hasInflight && hasPendingEnd && hasFinallyClear && endGatedByPending,
      `在途复用=${hasInflight}, 挂起 end=${hasPendingEnd}, finally 清理=${hasFinallyClear}, begin 内 end 调用=${endCallCount} 处且由挂起触发=${endGatedByPending}`)
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
