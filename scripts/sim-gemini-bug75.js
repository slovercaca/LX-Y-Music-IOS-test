#!/usr/bin/env node
/**
 * Bug 75 契约（2026-11-21，Gemini 全量审查）：
 *   LiquidLensView 的 displayLink 是强属性，CADisplayLink(target: self)
 *   强引用 target，且被加入主 RunLoop 后 RunLoop 也持有它，形成
 *   self → displayLink → self 强引用环。stopPositionTracking 只在 liftDown
 *   中被调；RN 在透镜滑动动画进行中卸载宿主时，动画以 finished=NO 完成
 *   而不回落 setLifted:NO → displayLink 永不停止 → 视图泄漏 +
 *   updatePositionTracking 以 60/120Hz 在已 detached 的视图上空转。
 *
 * 本脚本钉住的不变量（三道防线，缺一不可）：
 *   - weak 代理 target（DisplayLinkProxy 只弱持有视图），不再以 self 为 target。
 *   - willMove(toWindow: nil) 时兜底 stopPositionTracking()。
 *   - deinit 中兜底 invalidate()（单独加 deinit 不够：环不断则 deinit 永不执行，
 *     故 weak 代理 + willMove 才是真正打破环的手段）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LENS = path.join(ROOT, 'ios/Vendor/LiquidGlassKit/Sources/LiquidLensView.swift')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    check(false, `读取失败：${p}`)
    return ''
  }
}

console.log('Bug 75 契约（透镜 CADisplayLink 循环引用）：')

const src = read(LENS)

// --- weak 代理 ---
check(
  /private final class DisplayLinkProxy: NSObject \{\s*weak var target: LiquidLensView\?/.test(src),
  'DisplayLinkProxy 只弱持有视图（weak var target）',
)
check(
  /CADisplayLink\(target: proxy, selector: #selector\(DisplayLinkProxy\.tick\)\)/.test(src),
  'displayLink 经 weak 代理创建（target: proxy）',
)
check(
  !/CADisplayLink\(target: self/.test(src),
  '不再有 CADisplayLink(target: self)（强引用环已打破）',
)
check(
  /@objc func tick\(\) \{\s*target\?\.updatePositionTracking\(\)\s*\}/.test(src),
  '代理 tick 经弱引用转发（视图释放后即 no-op）',
)

// --- willMove(toWindow: nil) 兜底 ---
const willMoveStart = src.indexOf('public override func willMove(toWindow newWindow: UIWindow?) {')
const willMoveEnd = src.indexOf('// MARK: - Protocol Methods', willMoveStart)
const willMoveBody = willMoveStart >= 0 && willMoveEnd > willMoveStart ? src.slice(willMoveStart, willMoveEnd) : ''
check(willMoveBody.length > 0, 'willMove(toWindow:) 覆写存在')
if (willMoveBody.length > 0) {
  check(
    /if newWindow == nil \{\s*\/\/ 6-G75:[\s\S]*?stopPositionTracking\(\)/.test(willMoveBody),
    'willMove(toWindow: nil) 时兜底 stopPositionTracking()',
  )
  check(
    /\} else if isLifted && displayLink == nil \{\s*\/\/[\s\S]*?startPositionTracking\(\)/.test(willMoveBody),
    '重挂回窗口且仍抬起时恢复追踪（不丢抬起态行为）',
  )
}

// --- deinit 兜底 ---
const deinitStart = src.indexOf('deinit {')
const deinitEnd = src.indexOf('private func commonInit()', deinitStart)
const deinitBody = deinitStart >= 0 && deinitEnd > deinitStart ? src.slice(deinitStart, deinitEnd) : ''
check(
  deinitBody.length > 0 &&
  /displayLink\?\.invalidate\(\)/.test(deinitBody) &&
  /displayLink = nil/.test(deinitBody),
  'deinit 中兜底 invalidate() 并置 nil',
)

// --- 反例自检 ---
const fakeSrc = src.replace('CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick))', 'CADisplayLink(target: self, selector: #selector(updatePositionTracking))')
check(
  /CADisplayLink\(target: self/.test(fakeSrc),
  '反例自检：target 改回 self 后，无 self-target 检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
