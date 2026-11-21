#!/usr/bin/env node
/**
 * Bug 61 契约（Gemini 审查 2026-11-21）：
 *   自定义主题背景图被 undefined 覆盖且缺少 { uri } 包装——isCustom 分支只
 *   修正了 extInfo['bg-image'] 的字符串路径，从未给 bgImg 赋值；对象字面量
 *   中 ...extInfo 在前、'bg-image': bgImg 在后，自定义主题下 bgImg 为
 *   undefined，覆盖掉前面已拼好的正确路径；且裸字符串也不是合法
 *   ImageSourcePropType。
 *
 * 钉住的不变量：
 *   - isCustom 分支路径解析后加 bgImg = { uri: extInfo['bg-image'] }。
 *   - 内置主题路径（BG_IMAGES 查表）不动。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/theme/themes/index.ts')

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

console.log('Bug 61 自定义主题背景图契约：')

const src = read(FILE)
const customStart = src.indexOf('if (theme.isCustom) {')
const customBody = customStart >= 0 ? src.slice(customStart, src.indexOf('} else {', customStart)) : ''
check(customStart >= 0, '找到 isCustom 分支')
check(
  /if \(extInfo\['bg-image'\]\) \{\s*bgImg = \{ uri: extInfo\['bg-image'\] \}/.test(customBody),
  'isCustom 分支路径解析后 bgImg = { uri: extInfo[\'bg-image\'] }',
)
check(
  /bgImg = BG_IMAGES\[extInfo\['bg-image'\]\]/.test(src),
  '内置主题路径（BG_IMAGES 查表）不动',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
