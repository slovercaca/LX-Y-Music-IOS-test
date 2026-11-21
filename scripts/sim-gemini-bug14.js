/**
 * sim-gemini-bug14.js
 *
 * Bug 14（Gemini 全量审查 2026-11-21，核实：真实，潜伏缺陷暂无触发路径）：
 * src/plugins/lyric.ts 的 removePlayHook / removeSetLyricHook 未判空下标。
 *
 * 机制：两者均为 splice(indexOf(hook), 1)，未命中时 indexOf 返回 -1，
 * splice(-1, 1) 删除最后一个活跃钩子。同文件内 useLrcWordsMap 的清理函数
 * 就是 `idx >= 0` 再 splice 的正确范式，说明这两处是遗漏。
 * 当前代码无现成重复移除路径（onLyricPlay 唯一订阅方初始化时订阅一次从不取消；
 * effect 清理成对 add/remove），属导出 API 的 footgun：任何调用方两次调用
 * 取消函数即触发。
 *
 * 修法：先判 idx >= 0 再 splice，两行，零风险。
 *
 * 本脚本复刻修复后的移除逻辑，验证 4 个断言；另用内容锚点钉住真实源码。
 *
 * 运行：node scripts/sim-gemini-bug14.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/lyric.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻修复后的钩子增删（与 lrcTools 的 removePlayHook 同构）
// ---------------------------------------------------------------------------

const makeHookList = () => {
  const hooks = []
  return {
    hooks,
    add(hook) { hooks.push(hook) },
    // 修复后：先判 idx >= 0 再 splice
    remove(hook) {
      const idx = hooks.indexOf(hook)
      if (idx >= 0) hooks.splice(idx, 1)
    },
    // 修复前（反例对照）：无条件 splice(indexOf, 1)
    removeBeforeFix(hook) {
      hooks.splice(hooks.indexOf(hook), 1)
    },
  }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('sim-gemini-bug14：removeHook 未命中下标判空\n')

// 断言1（反例）：修复前，移除不存在的钩子会误删最后一个活跃钩子
{
  const list = makeHookList()
  const a = () => {}; const b = () => {}; const ghost = () => {}
  list.add(a); list.add(b)
  list.removeBeforeFix(ghost)
  check('修复前·移除不存在的钩子：最后一个活跃钩子被误删（缺陷存在，反例）',
    list.hooks.length === 1 && list.hooks[0] === a,
    `剩余=${list.hooks.length} 个，b 被误删=${!list.hooks.includes(b)}`)
}

// 断言2（修复验证，断言1的反例）：修复后，移除不存在的钩子是 no-op
{
  const list = makeHookList()
  const a = () => {}; const b = () => {}; const ghost = () => {}
  list.add(a); list.add(b)
  list.remove(ghost)
  check('修复后·移除不存在的钩子：两个活跃钩子都在（no-op）',
    list.hooks.length === 2 && list.hooks[0] === a && list.hooks[1] === b,
    `剩余=${list.hooks.length} 个`)
}

// 断言3：重复调用取消函数（两次移除同一钩子）第二次是 no-op
{
  const list = makeHookList()
  const a = () => {}; const b = () => {}
  list.add(a); list.add(b)
  list.remove(a)
  list.remove(a) // 第二次：已不在列表中
  check('修复后·重复移除同一钩子：第二次 no-op，不误删 b',
    list.hooks.length === 1 && list.hooks[0] === b,
    `剩余=${list.hooks.length} 个，b 仍在=${list.hooks.includes(b)}`)
}

// 断言4：正常移除仍工作（回归）
{
  const list = makeHookList()
  const a = () => {}; const b = () => {}; const c = () => {}
  list.add(a); list.add(b); list.add(c)
  list.remove(b)
  check('修复后·正常移除中间钩子：只删目标',
    list.hooks.length === 2 && list.hooks[0] === a && list.hooks[1] === c,
    `剩余=${list.hooks.length} 个`)
}

// 断言5（内容锚点）：真实源码里两处 remove 都有 idx >= 0 判空
{
  const removePlayBlock = SRC.slice(SRC.indexOf('removePlayHook(hook: PlayHook)'), SRC.indexOf('addSetLyricHook'))
  const removeSetBlock = SRC.slice(SRC.indexOf('removeSetLyricHook(hook: SetLyricHook)'), SRC.indexOf('setLyric() {'))
  const playGuarded = removePlayBlock.includes('if (idx >= 0)')
  const setGuarded = removeSetBlock.includes('if (idx >= 0)')
  const noBareSplice = !SRC.includes('splice(this.playHooks.indexOf(hook), 1)') &&
    !SRC.includes('splice(this.setLyricHooks.indexOf(hook), 1)')
  check('源码锚点：removePlayHook 与 removeSetLyricHook 均先判 idx >= 0，裸 splice 已除',
    playGuarded && setGuarded && noBareSplice,
    `play 判空=${playGuarded}, setLyric 判空=${setGuarded}, 无裸 splice=${noBareSplice}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
