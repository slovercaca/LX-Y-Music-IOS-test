// import mitt from 'mitt'
// import type { Emitter } from 'mitt'

export default class Event {
  listeners: Map<string, Array<(...args: any[]) => any>>
  constructor() {
    this.listeners = new Map()
  }

  on(eventName: string, listener: (...args: any[]) => any) {
    let targetListeners = this.listeners.get(eventName)
    if (!targetListeners) this.listeners.set(eventName, (targetListeners = []))
    targetListeners.push(listener)
  }

  off(eventName: string, listener: (...args: any[]) => any) {
    let targetListeners = this.listeners.get(eventName)
    if (!targetListeners) return
    const index = targetListeners.indexOf(listener)
    if (index < 0) return
    targetListeners.splice(index, 1)
  }

  emit(eventName: string, ...args: any[]) {
    // 低：在 emit 调用时就快照监听者名单——此前 setImmediate 派发前新挂载
    // 组件订阅同名事件会收到订阅前发生的命令类事件（play/pause），可能误执行一次
    const targetListeners = this.listeners.get(eventName)
    if (!targetListeners) return
    const snapshot = targetListeners.slice()
    setImmediate(() => {
      // 2026-10-05 fix（P0-2）：快照+异常隔离——单个 listener 抛错不掐断后续；
      // listener 中 off 自己不导致跳过下一个
      for (const listener of snapshot) {
        try {
          listener(...args)
        } catch (err) {
          console.error(`Event "${eventName}" listener error:`, err)
        }
      }
    })
  }

  offAll(eventName: string) {
    let targetListeners = this.listeners.get(eventName)
    if (!targetListeners) return
    this.listeners.delete(eventName)
  }
}

// export class App_EVENT {
//   listeners: Map<string, Array<() => void>>
//   constructor() {
//     this.listeners = new Map()
//   }

//   on(eventName: string, listener: () => void) {
//     let targetListeners = this.listeners.get(eventName)
//     if (targetListeners) this.listeners.set(eventName, targetListeners = [])
//     targetListeners!.push(listener)
//   }

//   off(eventName: string, listener: () => void) {

//   }
// }
