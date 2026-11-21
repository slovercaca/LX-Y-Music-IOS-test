#!/usr/bin/env node
/**
 * Bug 77 契约（2026-11-21，Gemini 全量审查）：
 *   updateUniforms() 把 touchPoint 与 liquidGlass.tintColor 写入
 *   uniformsBuffer，但唯一调用点是 layoutSubviews；draw(_:) 直接用
 *   uniformsBuffer 渲染，不调用它。touchPoint 是 plain var（无 didSet），
 *   setGlassTintColor 也只写值——手指拖动/切主题色时无布局发生，眩光位置
 *   冻结、染色不生效（MTKView 连续渲染每帧都在跑，读的都是陈旧值）。
 *   修法：draw(_:) 渲染前调 updateUniforms()（改动最小，一个文件一行，
 *   覆盖全部 uniform 输入；每帧成本只是十几个浮点赋值）。
 *
 * 本脚本钉住的不变量：
 *   - draw(_:) 在渲染前调 updateUniforms()（在 autoCapture/各 guard 之前）。
 *   - layoutSubviews 仍调 updateUniforms()（原有行为不变）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const GLASS_VIEW = path.join(ROOT, 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift')

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

console.log('Bug 77 契约（draw 前刷新 uniforms）：')

const src = read(GLASS_VIEW)

// --- draw(_:) 渲染前调 updateUniforms() ---
const drawStart = src.indexOf('override func draw(_ rect: CGRect) {')
const drawEnd = src.indexOf('extension UIColor {', drawStart)
const drawBody = drawStart >= 0 && drawEnd > drawStart ? src.slice(drawStart, drawEnd) : ''
check(drawBody.length > 0, '定位到 draw(_:) 函数体')
if (drawBody.length > 0) {
  // 行锚定匹配真正的调用行（注释里也提到 updateUniforms，别误命中注释）
  const callMatch = drawBody.match(/^        updateUniforms\(\)$/m)
  const updateAt = callMatch ? callMatch.index : -1
  const captureAt = drawBody.indexOf('if autoCapture {')
  const guardAt = drawBody.indexOf('guard backgroundTexture != nil')
  const renderAt = drawBody.indexOf('encoder.setRenderPipelineState(pipeline)')
  check(
    updateAt >= 0,
    'draw(_:) 内调用 updateUniforms()',
  )
  check(
    updateAt >= 0 && updateAt < captureAt && updateAt < guardAt && updateAt < renderAt,
    'updateUniforms() 在 autoCapture/guard/渲染之前（本帧即用新值）',
  )
}

// --- layoutSubviews 仍调 updateUniforms()（原有行为不变） ---
const layoutStart = src.indexOf('override func layoutSubviews() {')
const layoutEnd = src.indexOf('override func draw(_ rect: CGRect) {', layoutStart)
const layoutBody = layoutStart >= 0 && layoutEnd > layoutStart ? src.slice(layoutStart, layoutEnd) : ''
check(
  layoutBody.length > 0 && /updateUniforms\(\)/.test(layoutBody),
  'layoutSubviews 仍调 updateUniforms()（原有调用点保留）',
)

// --- 反例自检（同样行锚定，只删调用行，注释提及不算） ---
const fakeDraw = drawBody.replace('        updateUniforms()\n', '')
check(
  !/^        updateUniforms\(\)$/m.test(fakeDraw),
  '反例自检：draw 内删掉 updateUniforms() 后，调用检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
