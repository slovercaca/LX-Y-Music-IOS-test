/**
 * trackPlayer 生命周期事件抑制守卫。
 *
 * 背景：iOS 上切歌/重建播放器时，中间态的 trackPlayer 事件（reset 触发的
 * state 变化等）不能进统一事件总线，否则 UI 状态机错乱，所以用
 * global.lx.playerStatus.ignoreTrackPlayerLifecycle 做抑制窗口。
 *
 * 原来实现是裸布尔量，不支持嵌套：并发的 load（换歌装载）与 reloadConfig
 *（重建播放器）互相交错时，先完成的 finally 会提前关闭后进入者的保护窗口，
 * 导致陈旧事件泄漏；反过来，若用"只有最新代际才能关"的修法，不走 native
 * 分支的代际又会把 flag 永久泄漏为 true。
 *
 * 这里改成引用计数：acquire() 拿一次保护，返回的 release() 必须在 finally
 * 里调用；release() 幂等，计数归零时才真正关闭 flag。嵌套/交错都安全。
 */
let guardCount = 0

export const acquireLifecycleGuard = (): (() => void) => {
  guardCount += 1
  global.lx.playerStatus.ignoreTrackPlayerLifecycle = true
  let released = false
  return () => {
    if (released) return
    released = true
    guardCount = Math.max(0, guardCount - 1)
    if (guardCount === 0) {
      global.lx.playerStatus.ignoreTrackPlayerLifecycle = false
    }
  }
}
