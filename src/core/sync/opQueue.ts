import { saveData, getData } from '@/plugins/storage'
import { storageDataPrefix } from '@/config/constant'

export type ListOperation = LX.Sync.List.ActionList

let operationQueue: ListOperation[] = []
const STORAGE_KEY = storageDataPrefix.sync + 'op_queue_v2'

let loadPromise: Promise<void> | null = null
let loadFailed = false
// 全量修复：加载失败时暂存的、还没落盘的操作。logOperation 在加载
// 仍失败时把操作先放这里，不直接落盘覆盖存储；下次加载成功时
// 再合并进内存队列，这样旧未同步操作不会被残缺内存队列抹掉。
let pendingOperations: ListOperation[] = []

/**
 * Load local unsynced operation queue
 * 中：加载失败此前被空 catch 吞掉（parse 失败在 storage 层无日志），
 * 内存队列归零后任意一次 logOperation 落盘会把未同步操作永久抹除。
 * 现在：显式记日志、标记失败，并提供就绪门——同步流程 await 它之后
 * 再读队列，避免加载完成前入队的操作被无条件赋值覆盖（存疑项一并处理）。
 * 全量修复：加载失败时必须清掉 loadPromise，否则“重试加载”只是
 * 返回同一个已决议的 promise，永远不会真的再读存储，死代码。
 */
export function loadOperationQueue(): Promise<void> {
  if (loadPromise && !loadFailed) return loadPromise
  if (loadFailed) loadPromise = null
  loadPromise = (async() => {
    try {
      const storedQueue = await getData<ListOperation[]>(STORAGE_KEY)
      operationQueue = [...(Array.isArray(storedQueue) ? storedQueue : []), ...pendingOperations]
      pendingOperations = []
      loadFailed = false
      console.log('[Sync OpQueue] Loaded operations:', operationQueue.length)
    } catch (err) {
      loadFailed = true
      console.error('[Sync OpQueue] 加载操作队列失败，未同步操作可能丢失:', err)
    }
  })()
  return loadPromise
}

/** 等待队列首次加载完成（同步流程读队列前调用） */
export async function whenOperationQueueReady(): Promise<void> {
  await loadOperationQueue()
  // 全量修复：加载仍失败时绝不能带着残缺内存队列继续同步——
  // 同步收尾的清队列落盘会把存储里的旧未同步操作永久抹掉。
  // 直接中止本轮同步，等存储恢复后再由下一轮重试。
  if (loadFailed) throw new Error('操作队列加载失败，同步已中止以防丢失未同步操作')
}

/**
 * Log a new operation to the queue
 * @param operation the operation object
 */
export async function logOperation(operation: ListOperation): Promise<void> {
  // 加载失败时先重试加载一次，避免用残缺内存队列落盘覆盖存储
  if (loadFailed) await loadOperationQueue()
  if (loadFailed) {
    // 仍失败：操作先暂存内存，不落盘——落盘会把存储里的旧未同步
    // 操作抹掉。本地编辑本身已先保存，同步流程在就绪门会重试加载
    // 并合并暂存操作，不会静默丢失。
    pendingOperations.push(operation)
    operationQueue.push(operation)
    console.error('[Sync OpQueue] 存储仍不可读，操作暂存内存待重试:', operation.action)
    return
  }
  operationQueue.push(operation)
  await saveData(STORAGE_KEY, operationQueue)
}

/**
 * Get all current operation queue
 */
export function getOperationQueue(): ListOperation[] {
  return [...operationQueue]
}

/**
 * Clear operation queue
 */
export async function clearOperationQueue(): Promise<void> {
  operationQueue = []
  await saveData(STORAGE_KEY, [])
}

/**
 * 高：只清掉快照里的那批操作——同步进行期间用户新入队的操作不在
 * 快照内，必须保留。此前同步收尾无条件整表清空，同步窗口内的本地
 * 编辑（增删歌曲）会被静默抹掉且不可恢复。
 */
export async function clearOperationQueueSnapshot(snapshot: ListOperation[]): Promise<void> {
  if (!snapshot.length) return
  // 全量修复：加载失败时内存队列可能残缺，清完落盘会抹掉存储里
  // 的旧操作。同步流程在就绪门已拦截加载失败，走到这里时本应已
  // 成功；这里再守一道，不落盘、不清内存，下轮重试时再处理。
  if (loadFailed) {
    console.error('[Sync OpQueue] 加载失败，跳过清队列落盘以防抹掉旧操作')
    return
  }
  const done = new Set(snapshot)
  operationQueue = operationQueue.filter(op => !done.has(op))
  await saveData(STORAGE_KEY, operationQueue)
}
