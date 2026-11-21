#!/usr/bin/env node
/**
 * Bug 76 契约（2026-11-21，Gemini 全量审查）：
 *   LGLiquidGlassHostView.installGlassBacking: 用 [[UIView alloc] init]
 *   （CGRectZero）创建容器，只设 autoresizingMask；已布局的宿主在运行时
 *   切换 liquid 模式时宿主 bounds 不变，autoresizing 不触发，新容器/背衬
 *   永久 0×0 不可见；且 layoutSubviews 只同步圆角、无任何 frame 同步，
 *   连后续 layout pass 都修不好它。
 *
 * 本脚本钉住的不变量：
 *   - 容器用 initWithFrame:self.bounds 初始化。
 *   - layoutSubviews 中同步 _glassView.frame 与 _glassBacking.frame。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MANAGER = path.join(ROOT, 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassViewManager.mm')

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

console.log('Bug 76 契约（玻璃背衬运行时切换 0×0）：')

const src = read(MANAGER)

// --- installGlassBacking: 按宿主 bounds 初始化容器 ---
const installStart = src.indexOf('- (void)installGlassBacking:(UIView *)backing {')
const installEnd = src.indexOf('- (void)reapplyCachedPropsToBacking', installStart)
const installBody = installStart >= 0 && installEnd > installStart ? src.slice(installStart, installEnd) : ''
check(installBody.length > 0, '定位到 installGlassBacking: 函数体')
if (installBody.length > 0) {
  check(
    /UIView \*container = \[\[UIView alloc\] initWithFrame:self\.bounds\];/.test(installBody),
    '容器用 initWithFrame:self.bounds 初始化（非 CGRectZero）',
  )
  check(
    !/UIView \*container = \[\[UIView alloc\] init\];/.test(installBody),
    '旧的 [[UIView alloc] init]（CGRectZero）已消除',
  )
}

// --- layoutSubviews: 同步容器与背衬 frame ---
const layoutStart = src.indexOf('- (void)layoutSubviews {')
const layoutEnd = src.indexOf('- (void)didMoveToSuperview {', layoutStart)
const layoutBody = layoutStart >= 0 && layoutEnd > layoutStart ? src.slice(layoutStart, layoutEnd) : ''
check(layoutBody.length > 0, '定位到 LGLiquidGlassHostView.layoutSubviews 函数体')
if (layoutBody.length > 0) {
  check(
    /_glassView\.frame = self\.bounds;/.test(layoutBody),
    'layoutSubviews 同步容器 frame（填满宿主）',
  )
  check(
    /_glassBacking\.frame = _glassView\.bounds;/.test(layoutBody),
    'layoutSubviews 同步背衬 frame（填满容器）',
  )
  check(
    layoutBody.indexOf('_glassView.frame = self.bounds;') < layoutBody.indexOf('_glassBacking.frame = _glassView.bounds;'),
    '先同步容器、再同步背衬（背衬取容器新 bounds）',
  )
}

// --- 反例自检 ---
const fakeInstall = installBody.replace('[[UIView alloc] initWithFrame:self.bounds]', '[[UIView alloc] init]')
check(
  !/initWithFrame:self\.bounds/.test(fakeInstall),
  '反例自检：容器改回 [[UIView alloc] init] 后，初始化检查能失败',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
