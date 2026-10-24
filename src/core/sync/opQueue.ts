import { saveData, getData } from '@/plugins/storage'
import { storageDataPrefix } from '@/config/constant'

export type ListOperation = LX.Sync.List.ActionList

let operationQueue: ListOperation[] = []
const STORAGE_KEY = storageDataPrefix.sync + 'op_queue_v2'

let loadPromise: Promise<void> | null = null
let loadFailed = false

/**
 * Load local unsynced operation queue
 * 中：加载失败此前被空 catch 吞掉（parse 失败在 storage 层无日志），
 * 内存队列归零后任意一次 logOperation 落盘会把未同步操作永久抹除。
 * 现在：显式记日志、标记失败，并提供就绪门——同步流程 await 它之后
 * 再读队列，避免加载完成前入队的操作被无条件赋值覆盖（存疑项一并处理）。
 */
export function loadOperationQueue(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async() => {
    try {
      const storedQueue = await getData<ListOperation[]>(STORAGE_KEY)
      operationQueue = Array.isArray(storedQueue) ? storedQueue : []
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
}

/**
 * Log a new operation to the queue
 * @param operation the operation object
 */
export async function logOperation(operation: ListOperation): Promise<void> {
  // 加载失败时先重试加载一次，避免用残缺内存队列落盘覆盖存储
  if (loadFailed) await loadOperationQueue()
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
  const done = new Set(snapshot)
  operationQueue = operationQueue.filter(op => !done.has(op))
  await saveData(STORAGE_KEY, operationQueue)
}
