#!/usr/bin/env node
/**
 * Bug 62 契约（Gemini 审查 2026-11-21）：
 *   评论图片高度超限时用 h = 0 计算宽度导致竖长图拉伸——高度超限分支
 *   w = realWidth * (h / realHeight) 时 h 仍为 0 → w = 0，随后 setWH 用
 *   w || realWidth 回退为原宽、高被钳为 260，竖长图宽未等比缩小、高被压扁。
 *   对照上方宽度超限分支正确地用 w = realWidth * (MAX_IMAGE_HEIGHT /
 *   realHeight)，两分支写法不对称，属笔误。
 *
 * 钉住的不变量：
 *   - 高度超限分支用 w = realWidth * (MAX_IMAGE_HEIGHT / realHeight)。
 *   - if (w && !h) / else if (!w && h) 死分支已清理（w、h 恒为 0 才进入）。
 *   - 尺寸计算本身用纯函数模拟验证（竖长图等比缩放）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/Comment/components/CommentImage.tsx')

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

console.log('Bug 62 评论图片等比缩放契约：')

const src = read(FILE)

check(
  !/^\s*w = realWidth \* \(h \/ realHeight\)\s*$/m.test(src),
  '不再用 h = 0 计算宽度（旧代码，行锚定，排除注释提及）',
)
const heightBranch = src.match(/else if \(MAX_IMAGE_HEIGHT && realHeight > MAX_IMAGE_HEIGHT\) \{[\s\S]*?\}/)
check(
  !!heightBranch && /w = realWidth \* \(MAX_IMAGE_HEIGHT \/ realHeight\)/.test(heightBranch[0]),
  '高度超限分支用 MAX_IMAGE_HEIGHT / realHeight 等比缩放（与宽度分支对称）',
)
check(
  !/^\s*if \(w && !h\) \{/m.test(src) && !/^\s*\} else if \(!w && h\) \{/m.test(src),
  '死分支 if (w && !h) / else if (!w && h) 已清理（行锚定，排除注释提及）',
)
check(
  /let cancelled = false/.test(src) && /if \(cancelled\) return/.test(src) && /return \(\) => \{ cancelled = true \}/.test(src),
  '加卸载 cancelled 标记（加固项）',
)

// --- 尺寸计算模拟（与实现同规则，MAX_IMAGE_HEIGHT 取 260） ---
const MAX = 260
const calc = (realWidth, realHeight, maxWidth) => {
  let w = 0
  let h = 0
  if (maxWidth && realWidth > maxWidth) {
    w = maxWidth
    h = realHeight * (w / realWidth)
    if (MAX && h > MAX) {
      w = realWidth * (MAX / realHeight)
      h = MAX
    }
  } else if (MAX && realHeight > MAX) {
    w = realWidth * (MAX / realHeight)
    h = MAX
  }
  return { width: w || realWidth, height: h || realHeight }
}
// 竖长图 400×2000（宽超限 + 高超限）：应等比缩为 52×260
const tall = calc(400, 2000, 300)
check(
  tall.width === 52 && tall.height === 260,
  `竖长图 400×2000 → ${tall.width}×${tall.height}（等比，宽高比 0.2 保持）`,
)
// 窄竖长图 200×2000（仅高超限）：应等比缩为 26×260
const narrow = calc(200, 2000, 300)
check(
  narrow.width === 26 && narrow.height === 260,
  `窄竖长图 200×2000 → ${narrow.width}×${narrow.height}（等比）`,
)
// 正常图 300×200 不变
const normal = calc(300, 200, 400)
check(
  normal.width === 300 && normal.height === 200,
  '正常图 300×200 尺寸不变',
)
// 旧公式对照：h=0 时 w 算出 0，回退为原宽 → 宽高比被破坏
const oldW = 200 * (0 / 2000)
check(
  (oldW || 200) === 200,
  '旧公式对照：h=0 时 w=0，回退原宽 200×260（宽高比破坏，确认 bug 机制）',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
