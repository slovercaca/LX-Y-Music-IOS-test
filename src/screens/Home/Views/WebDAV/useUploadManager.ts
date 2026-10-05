import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirmDialog, toast } from '@/utils/tools'
import { selectFile, stat, unlink } from '@/utils/fs'
import { saveData, getData, removeData } from '@/plugins/storage'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useDownloadTasks } from '@/store/download/hook'
import {
  buildUploadRemotePath,
  findLocalLyricFile,
  putFileWithProgress,
  UploadAbortedError,
  type WebDAVUploadQueueItem,
  type WebDAVUploadHistoryItem,
  type WebDAVUploadQueueState,
} from '@/core/webdavMusic/upload'
import { contentTypeForExt } from '@/core/webdavMusic/library'
import { webDAVLog } from '@/core/webdavMusic/logger'

/** 上传历史存储键 */
const UPLOAD_HISTORY_KEY = '@webdav_upload_history_v1'
const HISTORY_LIMIT = 100
/** 进度 UI 刷新节流 */
const PROGRESS_BUMP_MS = 250

export interface UploadManagerDeps {
  /** 当前上传目标目录（用户在目录 tab 选的文件夹，无选择时为根） */
  getTargetDir: () => string
  /** 是否同时上传歌词 */
  getWithLyrics: () => boolean
  /** 连接预检（不通直接抛错） */
  testConnection: () => Promise<void>
  /** 远端存在性检查（冲突预检用） */
  checkRemoteExists: (remotePath: string) => Promise<boolean>
  /** 队列排空（无 queued/uploading 项）时的回调：调用方做重扫与汇总提示 */
  onQueueDrained: (summary: { completed: number; failed: number }) => void
}

export interface UploadQueueStats {
  total: number
  queued: number
  uploading: number
  paused: number
  completed: number
  failed: number
  totalBytes: number
  uploadedBytes: number
}

const newId = (() => {
  let n = 0
  return () => `${Date.now().toString(36)}-${(n++).toString(36)}`
})()

const fileNameOf = (p: string) => p.split('/').pop() || p
const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase()

/**
 * WebDAV 上传管理器（队列 + 并发 + 真实进度 + 历史）。
 *
 * 状态机（显式，不再靠零散 flag 推断，修复"上传完成仍显示上传中"）：
 * - queueState: idle / uploading / paused，任何路径离开 uploading 都走 finish 路径
 * - item.status: queued / uploading / paused / completed / failed / cancelled
 *
 * 并发：worker 池，线程数来自设置 webdav.uploadConcurrency（1-6，可调）。
 * 暂停：置 paused 标记 + abort 进行中的 XHR，item 回到 paused（续传=整体重传，
 * WebDAV PUT 幂等，原子覆盖，无断点续传复杂度）。
 */
export function useUploadManager(deps: UploadManagerDeps) {
  const itemsRef = useRef(new Map<string, WebDAVUploadQueueItem>())
  /** 进行中上传的 abort 句柄 */
  const abortHandlesRef = useRef(new Map<string, { abort: () => void }>())
  /** 用户单项暂停的 id：abort 回调据此置 paused 而非 cancelled */
  const userPausedRef = useRef(new Set<string>())
  /** 已从队列删除的 id：abort 回调直接清理，不写历史 */
  const removedRef = useRef(new Set<string>())
  const queueStateRef = useRef<WebDAVUploadQueueState>('idle')
  const generationRef = useRef(0)
  const lastBumpRef = useRef(0)
  const historyRef = useRef<WebDAVUploadHistoryItem[]>([])
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [version, setVersion] = useState(0)
  const [queueState, setQueueState] = useState<WebDAVUploadQueueState>('idle')
  const [history, setHistory] = useState<WebDAVUploadHistoryItem[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const concurrencySetting = useSettingValue('webdav.uploadConcurrency')
  const concurrency = Math.min(6, Math.max(1, Math.floor(Number(concurrencySetting) || 2)))

  const depsRef = useRef(deps)
  depsRef.current = deps

  const bump = useCallback((force = false) => {
    const now = Date.now()
    if (force || now - lastBumpRef.current >= PROGRESS_BUMP_MS) {
      lastBumpRef.current = now
      setVersion(v => v + 1)
    }
  }, [])

  const setState = useCallback((s: WebDAVUploadQueueState) => {
    queueStateRef.current = s
    setQueueState(s)
  }, [])

  // ---------------- 历史持久化 ----------------
  useEffect(() => {
    void getData<WebDAVUploadHistoryItem[]>(UPLOAD_HISTORY_KEY)
      .then(list => {
        if (Array.isArray(list)) {
          historyRef.current = list.slice(0, HISTORY_LIMIT)
          setHistory(historyRef.current)
        }
      })
      .catch(() => {})
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [])

  const persistHistory = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      void saveData(UPLOAD_HISTORY_KEY, historyRef.current.slice(0, HISTORY_LIMIT)).catch(() => {})
    }, 500)
  }, [])

  const pushHistory = useCallback((item: WebDAVUploadQueueItem) => {
    if (item.status !== 'completed' && item.status !== 'failed') return
    const record: WebDAVUploadHistoryItem = {
      id: item.id,
      fileName: item.fileName,
      size: item.size,
      kind: item.kind,
      remotePath: item.remotePath,
      status: item.status,
      error: item.error,
      finishedAt: item.finishedAt ?? Date.now(),
    }
    historyRef.current = [record, ...historyRef.current].slice(0, HISTORY_LIMIT)
    setHistory([...historyRef.current])
    persistHistory()
  }, [persistHistory])

  const clearHistory = useCallback(() => {
    historyRef.current = []
    setHistory([])
    void removeData(UPLOAD_HISTORY_KEY).catch(() => {})
  }, [])

  // ---------------- 队列派生 ----------------
  const items = useMemo(
    () => Array.from(itemsRef.current.values()).sort((a, b) => a.addedAt - b.addedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  )

  const stats = useMemo<UploadQueueStats>(() => {
    const s: UploadQueueStats = {
      total: 0, queued: 0, uploading: 0, paused: 0,
      completed: 0, failed: 0, totalBytes: 0, uploadedBytes: 0,
    }
    for (const it of itemsRef.current.values()) {
      s.total++
      s.totalBytes += it.size || 0
      if (it.status === 'completed') {
        s.completed++
        s.uploadedBytes += it.size || 0
      } else if (it.status === 'uploading') {
        s.uploading++
        s.uploadedBytes += Math.min(it.uploadedBytes, it.size || 0)
      } else if (it.status === 'failed') {
        s.failed++
      } else if (it.status === 'paused') {
        s.paused++
      } else if (it.status === 'queued') {
        s.queued++
      }
    }
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // ---------------- 入队 ----------------
  const addRawItems = useCallback((raw: Array<{
    localPath: string
    fileName: string
    size: number
    isTempFile: boolean
  }>) => {
    const targetDir = depsRef.current.getTargetDir()
    const withLyrics = depsRef.current.getWithLyrics()
    let added = 0
    const now = Date.now()
    for (const r of raw) {
      const fileName = r.fileName || fileNameOf(r.localPath)
      const kind = extOf(fileName) === 'lrc' ? 'lrc' : 'audio'
      const remotePath = buildUploadRemotePath(targetDir, fileName, kind)
      // 按 本地路径+远端路径 去重（同一文件重复添加直接跳过）
      let dup = false
      for (const it of itemsRef.current.values()) {
        if (it.localPath === r.localPath && it.remotePath === remotePath
          && it.status !== 'cancelled' && it.status !== 'failed' && it.status !== 'completed') {
          dup = true
          break
        }
      }
      if (dup) continue
      const item: WebDAVUploadQueueItem = {
        id: newId(),
        localPath: r.localPath,
        fileName,
        size: r.size || 0,
        kind,
        remotePath,
        targetDir,
        status: 'queued',
        uploadedBytes: 0,
        speed: 0,
        lastProgressAt: 0,
        isTempFile: r.isTempFile,
        addedAt: now,
      }
      itemsRef.current.set(item.id, item)
      added++

      // 音频入队时自动配对同名歌词（本地 music/ 与 lrc/ 结构兼容查找）
      if (kind === 'audio' && withLyrics) {
        const base = fileName.replace(/\.[^/.]+$/, '')
        void findLocalLyricFile(r.localPath, base).then(lrcPath => {
          if (!lrcPath) return
          const lrcName = fileNameOf(lrcPath)
          const lrcRemote = buildUploadRemotePath(targetDir, lrcName, 'lrc')
          for (const it of itemsRef.current.values()) {
            if (it.localPath === lrcPath && it.remotePath === lrcRemote) return
          }
          void stat(lrcPath).then(st => {
            const lrcId = newId()
            const lrcItem: WebDAVUploadQueueItem = {
              id: lrcId,
              localPath: lrcPath,
              fileName: lrcName,
              size: (st as { size?: number })?.size || 0,
              kind: 'lrc',
              remotePath: lrcRemote,
              targetDir,
              status: 'queued',
              uploadedBytes: 0,
              speed: 0,
              lastProgressAt: 0,
              isTempFile: false,
              addedAt: Date.now(),
            }
            itemsRef.current.set(lrcId, lrcItem)
            bump(true)
          }).catch(() => {})
        })
      }
    }
    if (added > 0) {
      bump(true)
      toast(`已加入上传队列 ${added} 个`)
    } else {
      toast('没有新文件加入（可能已在队列中）')
    }
  }, [bump])

  // ---------------- 上传执行 ----------------
  const takeNext = useCallback((): WebDAVUploadQueueItem | null => {
    for (const it of itemsRef.current.values()) {
      if (it.status === 'queued') {
        it.status = 'uploading'
        it.attempt = (it.attempt ?? 0) + 1
        it.uploadedBytes = 0
        it.speed = 0
        it.error = undefined
        it.lastProgressAt = Date.now()
        return it
      }
    }
    return null
  }, [])

  const finishItem = useCallback((item: WebDAVUploadQueueItem, status: WebDAVUploadQueueItem['status'], error?: string) => {
    abortHandlesRef.current.delete(item.id)
    userPausedRef.current.delete(item.id)
    item.status = status
    if (error) item.error = error
    if (status === 'completed') item.uploadedBytes = item.size
    item.finishedAt = Date.now()
    // 文件 App 选的临时文件：终态后删除，避免 tmp 堆积
    if (item.isTempFile && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
      void unlink(item.localPath).catch(() => {})
    }
    pushHistory(item)
    bump(true)
  }, [bump, pushHistory])

  const uploadOne = useCallback(async(item: WebDAVUploadQueueItem, gen: number) => {
    const attempt = item.attempt ?? 0
    const startAt = Date.now()
    let lastLoaded = 0
    let lastAt = startAt
    /** 本轮是否仍有效：item 未被删除、未被新一轮接管（防 stale worker 重复结算） */
    const stillMine = () => itemsRef.current.get(item.id) === item && item.attempt === attempt
    try {
      await putFileWithProgress({
        remotePath: item.remotePath,
        localPath: item.localPath,
        size: item.size,
        contentType: contentTypeForExt(extOf(item.fileName)),
        onProgress: (loaded, total) => {
          if (gen !== generationRef.current) return
          const now = Date.now()
          const dt = Math.max(1, now - lastAt) / 1000
          const instant = Math.max(0, (loaded - lastLoaded) / dt)
          lastLoaded = loaded
          lastAt = now
          item.uploadedBytes = loaded
          item.speed = item.speed > 0 ? item.speed * 0.7 + instant * 0.3 : instant
          item.lastProgressAt = now
          void total
          bump()
        },
      })
      if (!stillMine()) return
      webDAVLog.info('[upload] 完成', { fileName: item.fileName, remotePath: item.remotePath })
      finishItem(item, 'completed')
    } catch (err: any) {
      if (!stillMine()) {
        // 已被删除或被新一轮接管：只清理句柄，不结算
        abortHandlesRef.current.delete(item.id)
            userPausedRef.current.delete(item.id)
        return
      }
      // 已被删除的项：只清理，不写历史
      if (removedRef.current.has(item.id)) {
        removedRef.current.delete(item.id)
        abortHandlesRef.current.delete(item.id)
            userPausedRef.current.delete(item.id)
        return
      }
      if (err instanceof UploadAbortedError) {
        // 用户单项暂停计 paused；队列整体暂停计 paused；其他（删除）计 cancelled
        if (userPausedRef.current.has(item.id)) {
          userPausedRef.current.delete(item.id)
          finishItem(item, 'paused')
        } else if (queueStateRef.current === 'paused') {
          finishItem(item, 'paused')
        } else {
          finishItem(item, 'cancelled')
        }
        return
      }
      webDAVLog.error('[upload] 失败', { fileName: item.fileName, error: err?.message ?? err })
      finishItem(item, 'failed', err?.message ?? String(err))
    }
  }, [bump, finishItem])

  const activeCount = useCallback(() => {
    let n = 0
    for (const it of itemsRef.current.values()) {
      if (it.status === 'queued' || it.status === 'uploading') n++
    }
    return n
  }, [])

  const maybeDrain = useCallback((gen: number) => {
    if (gen !== generationRef.current) return
    if (activeCount() > 0) return
    // 队列排空：显式回到 idle/paused，杜绝"完成仍显示上传中"
    let completed = 0
    let failed = 0
    for (const it of itemsRef.current.values()) {
      if (it.status === 'completed') completed++
      else if (it.status === 'failed') failed++
    }
    if (queueStateRef.current === 'paused') {
      setState('paused')
    } else {
      setState('idle')
      generationRef.current++
      // 只有真正传过文件才回调（clearAll 等空排空不触发重扫）
      if (completed + failed > 0) {
        depsRef.current.onQueueDrained({ completed, failed })
      }
    }
    bump(true)
  }, [activeCount, bump, setState])

  const workerLoop = useCallback(async(gen: number) => {
    while (gen === generationRef.current && queueStateRef.current === 'uploading') {
      const item = takeNext()
      if (!item) break
      bump(true)
      await uploadOne(item, gen)
    }
    maybeDrain(gen)
  }, [takeNext, uploadOne, maybeDrain, bump])

  // ---------------- 对外控制 ----------------
  const start = useCallback(async() => {
    if (queueStateRef.current === 'uploading') return
    const pending = Array.from(itemsRef.current.values())
      .filter(it => it.status === 'queued' || it.status === 'paused' || it.status === 'failed')
    if (pending.length === 0) {
      toast('队列中没有可上传的文件')
      return
    }
    // 1. 本地校验：stat 失败/目录/空文件直接标失败，不占用线程
    for (const it of pending) {
      try {
        const st: any = await stat(it.localPath)
        if (!st || st.isDirectory || !st.size) {
          finishItem(it, 'failed', '本地文件不可读或为空')
        } else {
          if (st.size !== it.size) it.size = st.size
          // 校验通过：失败/暂停项回到排队（显式开始 = 全部跑起来）
          if (it.status === 'failed' || it.status === 'paused') it.status = 'queued'
        }
      } catch {
        finishItem(it, 'failed', '本地文件不可读')
      }
    }
    const ready = pending.filter(it => it.status === 'queued')
    if (ready.length === 0) {
      bump(true)
      return
    }

    // 2. 连接预检
    try {
      await depsRef.current.testConnection()
    } catch (err: any) {
      toast(`无法连接 WebDAV 服务器：${err?.message ?? err}`, 'long')
      return
    }

    // 3. 冲突预检（一次问清）
    const conflicts: string[] = []
    for (const it of ready) {
      if (await depsRef.current.checkRemoteExists(it.remotePath).catch(() => false)) {
        conflicts.push(it.fileName)
      }
    }
    if (conflicts.length > 0) {
      const confirmed = await confirmDialog({
        title: '文件已存在',
        message: `服务器上已有 ${conflicts.length} 个同名文件${conflicts.length <= 3 ? `：${conflicts.join('、')}` : ''}，上传将覆盖它们。继续吗？`,
        confirmButtonText: '覆盖并上传',
      })
      if (!confirmed) return
    }

    // 4. 大文件提醒
    const totalSize = ready.reduce((s, it) => s + (it.size || 0), 0)
    if (totalSize > 100 * 1024 * 1024) {
      const confirmed = await confirmDialog({
        title: '文件较大',
        message: `本次共 ${ready.length} 个文件，约 ${(totalSize / 1024 / 1024).toFixed(0)}MB。上传大文件较慢且耗内存，确定继续吗？`,
        confirmButtonText: '继续上传',
      })
      if (!confirmed) return
    }

    setState('uploading')
    const gen = ++generationRef.current
    bump(true)
    const n = concurrency
    await Promise.all(Array.from({ length: n }, () => workerLoop(gen)))
    // worker 全部退出后由 maybeDrain 收尾（idle 回调在那里触发）
  }, [bump, concurrency, finishItem, setState, workerLoop])

  const pause = useCallback(() => {
    if (queueStateRef.current !== 'uploading') return
    // 注意：这里不递增 generation——进行中的 abort 回调仍需正常流转，
    // 靠 abort 标记（stall/userPaused/removed/queueState）区分后状态；
    // worker 循环靠 queueStateRef 退出，无需 generation。
    setState('paused')
    // abort 进行中的 XHR；回退到 webdav 库的（无 abort 句柄）等它自然结束
    for (const [id, h] of abortHandlesRef.current) {
      const it = itemsRef.current.get(id)
      if (it && it.status === 'uploading') {
        try {
          h.abort()
        } catch {
          // ignore
        }
      }
    }
    bump(true)
  }, [bump, setState])

  const resume = useCallback(() => {
    if (queueStateRef.current !== 'paused') return
    // start 内部会把 paused/failed 项转回 queued 并走完整预检链路
    void start()
  }, [start])

  /** 单项暂停：排队中直接置 paused；上传中 abort（重传幂等），回调里按标记置 paused */
  const pauseItem = useCallback((id: string) => {
    const it = itemsRef.current.get(id)
    if (!it) return
    if (it.status === 'queued') {
      it.status = 'paused'
      bump(true)
      return
    }
    if (it.status === 'uploading') {
      userPausedRef.current.add(id)
      try {
        abortHandlesRef.current.get(id)?.abort()
      } catch {
        // 无 abort 句柄（回退传输中）则等其自然结束，结束后按标记置 paused
      }
    }
  }, [bump])

  const retryItem = useCallback((id: string) => {
    const it = itemsRef.current.get(id)
    if (!it || (it.status !== 'failed' && it.status !== 'cancelled' && it.status !== 'paused')) return
    it.status = 'queued'
    it.uploadedBytes = 0
    it.speed = 0
    it.error = undefined
    bump(true)
    if (queueStateRef.current === 'idle') {
      void start()
    }
  }, [bump, start])

  const removeItem = useCallback((id: string) => {
    const it = itemsRef.current.get(id)
    if (!it) return
    removedRef.current.add(id)
    if (it.status === 'uploading') {
      try {
        abortHandlesRef.current.get(id)?.abort()
      } catch {
        // ignore
      }
    }
    if (it.isTempFile) void unlink(it.localPath).catch(() => {})
    itemsRef.current.delete(id)
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    bump(true)
  }, [bump])

  /** 清空已完成/失败/取消的项（进行中的不受影响） */
  const clearFinished = useCallback(() => {
    let n = 0
    for (const [id, it] of itemsRef.current) {
      if (it.status === 'completed' || it.status === 'failed' || it.status === 'cancelled') {
        if (it.isTempFile) void unlink(it.localPath).catch(() => {})
        itemsRef.current.delete(id)
        n++
      }
    }
    if (n > 0) {
      bump(true)
      toast(`已清理 ${n} 个`)
    }
  }, [bump])

  /** 清空整个队列（含临时文件；上传中先暂停） */
  const clearAll = useCallback(() => {
    pause()
    for (const [id, it] of itemsRef.current) {
      removedRef.current.add(id)
      if (it.isTempFile) void unlink(it.localPath).catch(() => {})
      itemsRef.current.delete(id)
    }
    setSelectedIds(new Set())
    // 递增 generation：让残留 worker 的 maybeDrain 失效，避免把状态写回 paused
    // 或误触发 onQueueDrained
    generationRef.current++
    setState('idle')
    bump(true)
  }, [bump, pause, setState])

  // ---------------- 多选 ----------------
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const all = items.map(it => it.id)
      if (prev.size === all.length && all.length > 0) return new Set<string>()
      return new Set(all)
    })
  }, [items])

  const deleteSelected = useCallback(() => {
    if (selectedIds.size === 0) {
      toast('请先选择要删除的项')
      return
    }
    const ids = Array.from(selectedIds)
    for (const id of ids) {
      const it = itemsRef.current.get(id)
      if (!it) continue
      removedRef.current.add(id)
      if (it.status === 'uploading') {
        try {
          abortHandlesRef.current.get(id)?.abort()
        } catch {
          // ignore
        }
      }
      if (it.isTempFile) void unlink(it.localPath).catch(() => {})
      itemsRef.current.delete(id)
    }
    setSelectedIds(new Set())
    bump(true)
    toast(`已删除 ${ids.length} 个`)
  }, [bump, selectedIds])

  // ---------------- 添加来源 ----------------
  const downloadTasks = useDownloadTasks()
  const uploadableTasks = useMemo(
    () => downloadTasks.filter(t => t.status === 'completed' && t.filePath && t.fileName),
    [downloadTasks],
  )

  const addFromTasks = useCallback((ids: Set<string>) => {
    const raws = uploadableTasks
      .filter(t => ids.has(t.id))
      .map(t => ({
        localPath: t.filePath!,
        fileName: t.fileName!,
        size: (t as any).progress?.total || 0,
        isTempFile: false,
      }))
    if (raws.length === 0) {
      toast('请先勾选要上传的文件')
      return
    }
    addRawItems(raws)
  }, [uploadableTasks, addRawItems])

  /** 文件 App 单选加入（可重复点选多加）；支持音频与 .lrc */
  const addFromFilePicker = useCallback(() => {
    void selectFile({ extTypes: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape', 'lrc'] })
      .then(async(res) => {
        if (!res?.path) return
        const fileName = res.name || fileNameOf(res.path)
        let size = res.size || 0
        if (!size) {
          try {
            const st: any = await stat(res.path)
            size = st?.size || 0
          } catch {
            // ignore
          }
        }
        addRawItems([{ localPath: res.path, fileName, size, isTempFile: true }])
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [addRawItems])

  // ---------------- 并发数 ----------------
  const setConcurrency = useCallback((n: number) => {
    const v = Math.min(6, Math.max(1, Math.round(n)))
    updateSetting({ 'webdav.uploadConcurrency': v })
  }, [])

  // 卸载时 abort 所有进行中上传（页面级防护，正常流程走 pause/clearAll）
  useEffect(() => {
    return () => {
      generationRef.current++
      for (const [, h] of abortHandlesRef.current) {
        try {
          h.abort()
        } catch {
          // ignore
        }
      }
    }
  }, [])

  return {
    items,
    stats,
    queueState,
    history,
    selectedIds,
    concurrency,
    uploadableTasks,
    // 入队
    addFromTasks,
    addFromFilePicker,
    // 控制
    start,
    pause,
    resume,
    pauseItem,
    retryItem,
    removeItem,
    clearFinished,
    clearAll,
    // 多选
    toggleSelect,
    toggleSelectAll,
    deleteSelected,
    // 历史
    clearHistory,
    // 并发
    setConcurrency,
  }
}
