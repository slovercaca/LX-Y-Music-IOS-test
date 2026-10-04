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
    setImmediate(() => {
      const targetListeners = this.listeners.get(eventName)
      if (!targetListeners) return
      // 2026-10-05 fix（P0-2）：快照+异常隔离——单个 listener 抛错不掐断后续；
      // listener 中 off 自己不导致跳过下一个
      const snapshot = targetListeners.slice()
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
