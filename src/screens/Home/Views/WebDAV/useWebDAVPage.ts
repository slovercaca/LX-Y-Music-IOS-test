import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, type FlatList, type TextInput } from 'react-native'
import { confirmDialog, toast, getRowInfo } from '@/utils/tools'
import { LIST_IDS } from '@/config/constant'
import { overwriteListMusics } from '@/core/list'
import { playList } from '@/core/player/player'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { useHorizontalMode } from '@/utils/hooks'
import { usePlayMusicInfo } from '@/store/player/hook'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import {
  fetchWebDAVPic,
  getWebDAVConfig,
  listWebDAVFolders,
  saveWebDAVFilterPath,
  saveWebDAVSelectedFolder,
  scanWebDAVSongs,
  updateWebDAVMusicMeta,
  checkWebDAVRemoteExists,
} from '@/core/webdavMusic/drive'
import type { MusicMultiAddModalType } from '@/components/MusicMultiAddModal'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { testConnection, resetClient } from '@/utils/webdav'
import { existsFile, selectFile } from '@/utils/fs'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import {
  handleWebDAVDownload,
  handleFetchWebDAVPicFromOnline,
  handleBatchFetchCoversFromOnline,
  handleWebDAVRemove,
  handleWebDAVDownloadAndImport,
  requestCancelWebDAVBatchDownload,
  requestCancelWebDAVBatchFetchCovers,
} from './WebDAVListAction'
import { friendlyWebDAVError } from '@/core/webdavMusic/client'
import type { WebDAVListMenuType, SelectInfo as WebDAVSelectInfo } from './WebDAVListMenu'
import { useUploadManager } from './useUploadManager'

export type ActiveTab = 'config' | 'list' | 'folders' | 'upload'

/**
 * WebDAV 页面状态与逻辑（从旧 index.tsx 提取）。
 * 四个 tab（列表/目录/上传/配置）共用这一个 hook，UI 只负责渲染。
 */
export function useWebDAVPage() {
  const playMusicInfo = usePlayMusicInfo()
  const [activeTab, setActiveTab] = useState<ActiveTab>('list')

  // 未配置时不让进上传 tab（旧 TabButton onPress 里的守卫，收拢到这里）
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const hasConfig = !!(webdavUrl && webdavUsername)
  const selectTab = useCallback((tab: ActiveTab) => {
    if (tab === 'upload' && !hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    setActiveTab(tab)
  }, [hasConfig])

  // ---------------- 歌曲列表 ----------------
  const [loading, setLoading] = useState(false)
  const [songs, setSongs] = useState<LX.WebDAV.MusicInfo[]>([])
  const [scannedAt, setScannedAt] = useState<number | undefined>()
  const [filterPath, setFilterPath] = useState<string | null>(null)
  const [scanText, setScanText] = useState('')
  // P2（2026-10-06）：错误提示 5 秒后自动清除，避免永久钉在列表头
  const setScanTextTemp = (text: string) => {
    setScanText(text)
    if (text) {
      setTimeout(() => {
        setScanText(prev => (prev === text ? '' : prev))
      }, 5000)
    }
  }
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [batchLoadingText, setBatchLoadingText] = useState('')
  // 多选模式
  const [isSelecting, setIsSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  const musicMultiAddModalRef = useRef<MusicMultiAddModalType>(null)
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)
  // P1-15：目录加载请求序号，防快速切换时后发先至显示错乱
  const loadFoldersRequestIdRef = useRef(0)
  // 扫描取消令牌（W7）：「取消」按钮置 true，扫描循环逐目录检查
  const scanCancelRef = useRef(false)

  // ---------------- 目录浏览 ----------------
  const [folderStack, setFolderStack] = useState<LX.WebDAV.DriveFolder[]>([])
  const [folders, setFolders] = useState<LX.WebDAV.DriveFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<LX.WebDAV.DriveFolder | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const currentFolder = folderStack.at(-1) ?? null

  // ---------------- 上传 ----------------
  // 上传队列由 useUploadManager 管理（显式状态机：idle/uploading/paused）。
  // 这里只保留"同时上传歌词/封面"开关与目标目录派生。
  const [uploadWithLyrics, setUploadWithLyrics] = useState(true)
  const [uploadWithCover, setUploadWithCover] = useState(true)

  // ---------------- 配置 ----------------
  const webdavPassword = useSettingValue('sync.webdav.password')
  const webdavMediaSource = useSettingValue('webdav.mediaSource')
  const [isTesting, setIsTesting] = useState(false)

  // ================= 派生 =================

  const filteredSongs = useMemo(() => {
    let list = songs
    if (filterPath) {
      list = list.filter(song => {
        const path = song.meta.remotePath
        if (!path) return false
        const lastSlashIndex = path.lastIndexOf('/')
        const folderPath = path.substring(0, lastSlashIndex) || '/'
        return folderPath === filterPath
      })
    }
    const text = searchText.trim().toLowerCase()
    if (!text) return list
    return list.filter((item) => {
      return [
        item.name,
        item.singer,
        item.meta.fileName,
        item.meta.filePath,
        item.meta.remotePath,
      ].some(value => (value ?? '').toLowerCase().includes(text))
    })
  }, [searchText, songs, filterPath])

  const songFolders = useMemo(() => {
    const foldersMap = new Map<string, { name: string, path: string, count: number }>()
    songs.forEach(song => {
      const path = song.meta.remotePath
      if (!path) return
      const lastSlashIndex = path.lastIndexOf('/')
      if (lastSlashIndex === -1) return
      const folderPath = path.substring(0, lastSlashIndex) || '/'
      const folderName = folderPath === '/' ? '根目录' : (folderPath.split('/').pop() || '未知目录')

      const existing = foldersMap.get(folderPath)
      if (existing) {
        existing.count++
      } else {
        foldersMap.set(folderPath, { name: folderName, path: folderPath, count: 1 })
      }
    })
    return Array.from(foldersMap.values()).sort((a, b) => a.path.localeCompare(b.path))
  }, [songs])

  const headerText = useMemo(() => {
    if (batchLoadingText) return batchLoadingText
    if (searchText.trim()) return `${filteredSongs.length}/${songs.length} 首`
    return `${songs.length} 首${scannedAt ? ` · ${new Date(scannedAt).toLocaleString()}` : ''}`
  }, [batchLoadingText, filteredSongs.length, scannedAt, searchText, songs.length])

  // 上传目标目录：当前选中的文件夹，无选择时为根目录
  const uploadTargetDir = useMemo(
    () => selectedFolder?.path || '/',
    [selectedFolder],
  )

  // 上传队列排空后的重扫：让刚上传的歌曲出现在列表里（旧 runWebDAVUpload 尾部逻辑）
  const handleUploadDrainedRescan = useCallback(async(summary: { completed: number; failed: number }) => {
    const { completed, failed } = summary
    if (failed > 0) {
      toast(`上传结束：${completed} 成功，${failed} 失败（可在队列中重试）`, 'long')
    } else if (completed > 0) {
      toast(`上传完成：${completed} 个文件`)
    }
    if (completed > 0) {
      setLoading(true)
      setScanText('正在刷新列表...')
      try {
        scanCancelRef.current = false
        const { config } = await scanWebDAVSongs(selectedFolder, (count, path) => {
          setScanText(`已找到 ${count} 首，正在扫描：${path}`)
        }, () => scanCancelRef.current)
        setSongs(config.songs ?? [])
        setScannedAt(config.scannedAt)
      } catch (err: any) {
        webDAVLog.warn('[WebDAV] 上传后重扫失败', { error: err?.message ?? err })
        toast(friendlyWebDAVError(err), 'long')
      } finally {
        setScanText('')
        setLoading(false)
      }
    }
  }, [selectedFolder])

  // 上传管理器：队列 + 并发 + 真实进度 + 历史（显式状态机）
  const uploadManager = useUploadManager({
    getTargetDir: () => uploadTargetDir,
    getWithLyrics: () => uploadWithLyrics,
    getWithCover: () => uploadWithCover,
    testConnection,
    checkRemoteExists: checkWebDAVRemoteExists,
    onQueueDrained: (summary) => { void handleUploadDrainedRescan(summary) },
  })

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免歌曲行在超宽屏上
  // 被拉得过长、左右留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  const rowInfo = useMemo(() => {
    void isHorizontal
    return getRowInfo()
  }, [isHorizontal])
  const numColumns = rowInfo.rowNum ?? 1

  // ================= 歌曲/封面 =================

  const syncSongsCover = useCallback(async(songList: LX.WebDAV.MusicInfo[]) => {
    // 仅补充网盘内封面（快速直连下载到本地），不触发全平台搜索；
    // 全平台封面由播放详情页按需获取。限制并发 4，避免批量下载风暴。
    // P1-16：用函数式更新合并封面，不用闭包旧数组整体覆盖，
    // 避免扫描先完成写新结果、封面协程后完成写回旧列表导致新结果丢失。
    const picUpdates = new Map<string, string>()
    let index = 0
    const workers = Array.from({ length: 4 }, async() => {
      while (index < songList.length) {
        const i = index++
        const song = songList[i]
        if (song.meta.picUrl) continue
        try {
          const picUrl = await fetchWebDAVPic(song)
          if (picUrl) {
            picUpdates.set(song.id, picUrl)
          }
        } catch {
          // ignore error
        }
      }
    })
    await Promise.all(workers)
    if (picUpdates.size === 0) return
    setSongs(prevSongs => prevSongs.map(song => {
      const picUrl = picUpdates.get(song.id)
      if (!picUrl || song.meta.picUrl) return song
      return { ...song, meta: { ...song.meta, picUrl } }
    }))
  }, [])

  const loadConfig = useCallback(async() => {
    return getWebDAVConfig().then(config => {
      setSelectedFolder(config.selectedFolder ?? null)
      const songs = config.songs ?? []
      setSongs(songs)
      setScannedAt(config.scannedAt)
      setFilterPath(config.filterPath ?? null)
      void syncSongsCover(songs)
    })
  }, [syncSongsCover])

  const handleSetFilterPath = useCallback((path: string | null) => {
    setFilterPath(path)
    void saveWebDAVFilterPath(path)
  }, [])

  // ================= 配置页动作 =================

  // 连接配置：与「设置 → 数据同步 → WebDAV 同步」共用 sync.webdav.* 同一批键，
  // 写完立刻 resetClient()，让页面内的目录浏览/扫描/下载用上新凭据。
  const handleWebdavSettingChanged = useCallback(
    (key: 'sync.webdav.url' | 'sync.webdav.username' | 'sync.webdav.password') =>
      (text: string, callback: (value: string) => void) => {
        updateSetting({ [key]: text })
        resetClient()
        callback(text)
      },
    [],
  )

  const handleWebdavMediaSourceChanged = useCallback((source: 'file' | 'online') => {
    updateSetting({ 'webdav.mediaSource': source })
    toast(source === 'file' ? '已切换为从歌曲文件获取封面歌词' : '已切换为从云端插件获取封面歌词')
  }, [])

  const handleTestConnection = useCallback(async() => {
    if (isTesting) return
    // W5：先收键盘触发 InputItem 提交，等设置落库后再测，
    // 否则刚填的地址/密码还没保存，测的是旧凭据
    Keyboard.dismiss()
    await new Promise(resolve => setTimeout(resolve, 250))
    if (!settingState.setting['sync.webdav.url'] || !settingState.setting['sync.webdav.username']) {
      toast('请先填写服务器地址与用户名', 'long', 'top')
      return
    }
    setIsTesting(true)
    try {
      await testConnection()
      // 顶部弹窗，3.5 秒后自动消失
      toast('WebDAV 连接成功！', 'long', 'top')
    } catch (error: any) {
      webDAVLog.warn('[WebDAV] 连接测试失败', { error: error?.message ?? error })
      toast(`WebDAV 连接失败：${friendlyWebDAVError(error)}`, 'long', 'top')
    } finally {
      setIsTesting(false)
    }
  }, [isTesting])

  // ================= 目录页动作 =================

  const loadFolders = useCallback((folder: LX.WebDAV.DriveFolder | null) => {
    // P1-15：递增请求序号，回调里校验，过期响应直接丢弃
    const requestId = ++loadFoldersRequestIdRef.current
    setFolderLoading(true)
    void listWebDAVFolders(folder)
      .then((folders) => {
        if (requestId !== loadFoldersRequestIdRef.current) return
        setFolders(folders)
      })
      .catch((err: any) => {
        if (requestId !== loadFoldersRequestIdRef.current) return
        const message = err.message ?? String(err)
        toast(message, 'long')
      })
      .finally(() => {
        if (requestId !== loadFoldersRequestIdRef.current) return
        setFolderLoading(false)
      })
  }, [])

  // 下拉刷新目录：重新加载当前目录的子文件夹
  const handleRefreshFolders = useCallback(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  const handleSelectCurrentFolder = useCallback(() => {
    setLoading(true)
    void saveWebDAVSelectedFolder(currentFolder)
      .then((config) => {
        setSelectedFolder(config.selectedFolder ?? null)
        toast(`已选择：${config.selectedFolder?.path || 'WebDAV 根目录'}`)
      })
      .catch((err: any) => {
        toast(err.message ?? String(err), 'long')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [currentFolder])

  const enterFolder = useCallback((folder: LX.WebDAV.DriveFolder) => {
    setFolderStack(prev => [...prev, folder])
  }, [])

  const goBackFolder = useCallback(() => {
    setFolderStack(prev => prev.slice(0, -1))
  }, [])

  // ================= 扫描 / 刷新 =================

  // 扫描执行体：handleScan（带根目录确认）与下拉刷新（W17：下拉 = 远端重新扫描）共用。
  // 结果如实区分：完整 / 部分（有目录读失败）/ 已取消（W3/W7），错误用友好文案（W10）。
  const executeScan = useCallback(() => {
    scanCancelRef.current = false
    setLoading(true)
    setScanText('开始扫描...')
    void scanWebDAVSongs(selectedFolder, (count, path) => {
      setScanText(`已找到 ${count} 首，正在扫描：${path}`)
    }, () => scanCancelRef.current)
      .then(({ config, skippedDirs, cancelled }) => {
        const scannedSongs = config.songs ?? []
        setSongs(scannedSongs)
        setScanText('')
        if (cancelled) {
          toast(`已取消扫描：已找到 ${scannedSongs.length} 首（本次结果未保存）`, 'long')
          return
        }
        setScannedAt(config.scannedAt)
        setActiveTab('list')
        // W23：扫描完立即把已知的网盘封面补进列表，不必等下次进页面
        void syncSongsCover(scannedSongs)
        if (skippedDirs.length > 0) {
          toast(`扫描完成：${scannedSongs.length} 首（${skippedDirs.length} 个文件夹读取失败，已跳过）`, 'long')
        } else {
          toast(`扫描完成：${scannedSongs.length} 首`)
        }
      })
      .catch((err: any) => {
        webDAVLog.warn('[WebDAV] 扫描失败', { error: err?.message ?? err })
        const message = friendlyWebDAVError(err)
        setScanTextTemp(message)
        toast(message, 'long')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [selectedFolder, syncSongsCover])

  const handleScan = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    if (!selectedFolder) {
      void confirmDialog({
        title: '扫描 WebDAV 根目录',
        message:
          '根目录扫描会递归读取所有子目录。文件夹很多时可能较慢。确定继续扫描根目录？',
        confirmButtonText: '继续扫描',
      }).then((confirmed) => {
        if (confirmed) executeScan()
      })
      return
    }
    executeScan()
  }, [hasConfig, selectedFolder, executeScan])

  // 下拉刷新 = 远端重新扫描（W17）。旧行为「重读本地文件标签」名不符实：
  // 下拉的人想看的是服务器最新列表。未配置时给出明确提示。
  const handleRefresh = useCallback(() => {
    if (!hasConfig) {
      toast('未配置 WebDAV：请到「配置」页填写服务器地址与用户名', 'long')
      return
    }
    if (loading) return
    executeScan()
  }, [hasConfig, loading, executeScan])

  // 取消当前长操作（W7）：扫描置取消令牌；批量下载/封面走各自取消入口
  const handleCancelOperation = useCallback(() => {
    scanCancelRef.current = true
    requestCancelWebDAVBatchDownload()
    requestCancelWebDAVBatchFetchCovers()
    setBatchLoadingText('')
    setScanText('正在取消...')
  }, [])

  // ================= 播放 / 菜单 =================

  const showMenu = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo, index: number, position: { x: number, y: number, w: number, h: number }) => {
      webDAVListMenuRef.current?.show({ musicInfo, index }, position)
    },
    [],
  )

  const handlePlay = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo) => {
      // 多选模式下点击切换选中，不播放
      if (isSelecting) {
        setSelectedIds(prev => {
          const next = new Set(prev)
          if (next.has(musicInfo.id)) next.delete(musicInfo.id)
          else next.add(musicInfo.id)
          return next
        })
        return
      }
      // W22：队列与索引都用筛选后列表——用户看到什么就播什么，
      // 旧实现用全量 songs，搜索后点一首却从全库位置开播
      const index = filteredSongs.findIndex(item => item.id === musicInfo.id)
      if (index < 0) return
      void overwriteListMusics(LIST_IDS.TEMP, filteredSongs).then(() => {
        void playList(LIST_IDS.TEMP, index).then(() => {
          void (async() => {
            const config = await getWebDAVConfig()
            const updatedSongs = config.songs ?? []
            setSongs(updatedSongs)
            void syncSongsCover(updatedSongs)
          })()
        })
      })
    },
    [filteredSongs, syncSongsCover, isSelecting],
  )

  // 长按进入多选模式
  const handleLongPress = useCallback((musicInfo: LX.WebDAV.MusicInfo) => {
    setIsSelecting(true)
    setSelectedIds(new Set([musicInfo.id]))
  }, [])

  const exitSelectMode = useCallback(() => {
    setIsSelecting(false)
    setSelectedIds(new Set())
  }, [])

  const toggleSelectAll = useCallback(() => {
    // P1-12：空搜索结果时不清空已有选择
    if (filteredSongs.length === 0) return
    setSelectedIds(prev => {
      // 如果已全选则清空，否则全选当前筛选列表
      if (prev.size >= filteredSongs.length && filteredSongs.length > 0) return new Set<string>()
      return new Set(filteredSongs.map(s => s.id))
    })
  }, [filteredSongs])

  // 批量获取在线封面（2026-10-22 修正）：在线找封面后上传到 WebDAV 的 picture/，
  // 不是存 iOS 本地；本机显示走既有封面缓存。判定"无封面"以远端 picPath 为准。
  const handleBatchFetchCovers = useCallback(() => {
    const noCover = (s: LX.WebDAV.MusicInfo) => !s.meta.picPath && !s.meta.customPicPath
    const targets = selectedIds.size > 0
      ? filteredSongs.filter(s => selectedIds.has(s.id) && noCover(s))
      : filteredSongs.filter(noCover)
    if (!targets.length) {
      toast(selectedIds.size > 0 ? '选中的歌曲在网盘都有封面了' : '所有歌曲在网盘都有封面了')
      return
    }
    void confirmDialog({
      title: '批量获取封面',
      message: `将为 ${targets.length} 首网盘无封面的歌曲在线搜索封面，并上传到 WebDAV 的 picture/ 目录，供所有设备使用。封面为自动匹配，可能不准确。继续吗？`,
      confirmButtonText: '开始获取',
    }).then((confirmed) => {
      if (!confirmed) return
      exitSelectMode()
      setBatchLoadingText('正在获取并上传封面 0/' + targets.length)
      void handleBatchFetchCoversFromOnline(targets, (current, total, songName) => {
        setBatchLoadingText(`正在获取并上传封面 ${current}/${total}`)
      }).then(async({ success, failed, failures, failedSongs, cancelled }) => {
        setBatchLoadingText('')
        // 中-5：用户取消后不再弹失败重试框
        if (cancelled) {
          toast(`已取消获取封面（已完成 ${success} 首）`)
          return
        }
        // W15：失败给明细并可只重试失败项，不再只报一个数字
        if (failed > 0 && failedSongs.length > 0) {
          const detail = failures.slice(0, 5).map(f => `${f.name}（${f.reason}）`).join('；')
          const retry = await confirmDialog({
            title: '部分封面获取失败',
            message: `成功 ${success}，失败 ${failed}：${detail}${failures.length > 5 ? '…' : ''}。是否只重试失败的歌曲？`,
            cancelButtonText: '不了',
            confirmButtonText: '重试失败项',
          }).catch(() => false)
          if (retry) {
            setBatchLoadingText('正在重试获取封面 0/' + failedSongs.length)
            const retryResult = await handleBatchFetchCoversFromOnline(failedSongs, (current, total) => {
              setBatchLoadingText(`正在重试获取封面 ${current}/${total}`)
            }).catch(() => null)
            setBatchLoadingText('')
            if (retryResult) toast(`重试完成：成功 ${retryResult.success}，失败 ${retryResult.failed}`)
          }
        } else {
          toast(`封面上传完成：成功 ${success}，失败 ${failed}`)
        }
        // 刷新列表显示新封面
        void loadConfig()
      }).catch((err: any) => {
        setBatchLoadingText('')
        webDAVLog.warn('[WebDAV] 批量获取封面失败', { error: err?.message ?? err })
        toast(`获取失败：${friendlyWebDAVError(err)}`, 'long')
      })
    })
  }, [filteredSongs, selectedIds, exitSelectMode, loadConfig])

  // 批量下载选中歌曲
  const handleDownloadSelected = useCallback(() => {
    const selected = filteredSongs.filter(s => selectedIds.has(s.id))
    if (!selected.length) {
      toast('请先选择歌曲')
      return
    }
    exitSelectMode()
    void handleWebDAVDownloadAndImport(selected, setBatchLoadingText)
  }, [filteredSongs, selectedIds, exitSelectMode])

  // 批量添加到歌单
  const handleAddSelectedToPlaylist = useCallback(() => {
    const selected = filteredSongs.filter(s => selectedIds.has(s.id))
    if (!selected.length) {
      toast('请先选择歌曲')
      return
    }
    // WebDAV.MusicInfo 已继承 MusicInfoLocal，直接传扁平数组
    //（MusicMultiAddModal 的 SelectInfo.selectedList 要求 LX.Music.MusicInfo[]）
    musicMultiAddModalRef.current?.show({
      selectedList: selected,
      listId: '',
      isMove: false,
    })
    exitSelectMode()
  }, [filteredSongs, selectedIds, exitSelectMode])

  const patchSongInList = useCallback((musicId: string, patch: (song: LX.WebDAV.MusicInfo) => LX.WebDAV.MusicInfo) => {
    setSongs(prevSongs => prevSongs.map(song => (song.id === musicId ? patch(song) : song)))
  }, [])

  const handlePlayLater = useCallback((info: WebDAVSelectInfo) => {
    addTempPlayList([{ listId: null, musicInfo: info.musicInfo }])
    toast('已添加到稍后播放')
  }, [])

  const handleLoadMetadata = useCallback(async(info: WebDAVSelectInfo) => {
    const musicInfo = info.musicInfo
    if (!musicInfo.meta.filePath) {
      toast('请先下载歌曲')
      return
    }
    try {
      toast('正在读取标签...')
      const fileMetadata = await readMetadata(musicInfo.meta.filePath)
      const picPath = await readPic(musicInfo.meta.filePath).catch(() => null)

      if (!fileMetadata) {
        toast('没有找到标签信息')
        return
      }

      const updates: Record<string, any> = {}
      if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
      if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
      if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
      if (picPath) {
        const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
        updates.picUrl = newPicUrl
      }

      if (Object.keys(updates).length > 0) {
        await updateWebDAVMusicMeta(musicInfo.id, updates)
        patchSongInList(musicInfo.id, song => ({ ...song, ...updates, meta: { ...song.meta, ...updates } }))
        toast('标签加载成功')
      } else {
        toast('没有新的标签信息')
      }
    } catch (error: any) {
      toast(`加载标签失败：${error.message}`, 'long')
    }
  }, [patchSongInList])

  const handleDownload = useCallback((info: WebDAVSelectInfo) => {
    // P1（2026-10-12）：下载后把 filePath 同步到列表内存状态，
    // 否则同一会话内点播拿的是旧对象（filePath 为空），离线无法播放。
    void handleWebDAVDownload(info.musicInfo).then((result) => {
      if (!result) return
      patchSongInList(info.musicInfo.id, song => ({
        ...song,
        meta: {
          ...song.meta,
          filePath: result.filePath,
          ...(result.picUrl ? { picUrl: result.picUrl } : {}),
        },
      }))
    })
  }, [patchSongInList])

  const handleFetchPicFromOnline = useCallback((info: WebDAVSelectInfo) => {
    void handleFetchWebDAVPicFromOnline(info.musicInfo).then((newPicUrl) => {
      // 低-9：失败时返回 undefined，此前无条件覆写 picUrl → 封面当场变空白
      if (!newPicUrl) {
        toast('获取封面失败，请重试')
        return
      }
      patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, picUrl: newPicUrl } }))
    })
  }, [patchSongInList])

  const handleSpecifyPicFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] })
      .then((res) => {
        if (!res?.path) return
        // picker 复制的临时文件长期保留（作为该歌曲的封面），不删除
        void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: res.path })
          .then(() => {
            patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, customPicPath: res.path } }))
            toast('已指定封面文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [patchSongInList])

  const handleSpecifyLrcFile = useCallback((info: WebDAVSelectInfo) => {
    void selectFile({ extTypes: ['lrc'] })
      .then((res) => {
        if (!res?.path) return
        void updateWebDAVMusicMeta(info.musicInfo.id, { customLrcPath: res.path })
          .then(() => {
            patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, customLrcPath: res.path } }))
            toast('已指定歌词文件')
          })
          .catch((err: any) => { toast(`保存失败：${err?.message ?? err}`, 'long') })
      })
      .catch((err: any) => {
        if (err?.code === 'picker_cancelled') return
        toast(`无法打开文件选择器：${err?.message ?? err}`, 'long')
      })
  }, [patchSongInList])

  // 清除手动指定的封面/歌词，恢复自动获取（传 '' 才会走 delete 分支真正持久化清除）
  const handleClearCustomMedia = useCallback((info: WebDAVSelectInfo) => {
    void updateWebDAVMusicMeta(info.musicInfo.id, { customPicPath: '', customLrcPath: '' })
      .then(() => {
        patchSongInList(info.musicInfo.id, song => {
          const meta = { ...song.meta }
          delete meta.customPicPath
          delete meta.customLrcPath
          return { ...song, meta }
        })
        toast('已清除手动指定，恢复自动获取')
      })
      .catch((err: any) => { toast(`清除失败：${err?.message ?? err}`, 'long') })
  }, [patchSongInList])

  const handleEditMetadata = useCallback((info: WebDAVSelectInfo) => {
    const filePath = info.musicInfo.meta.filePath
    // 编辑标签只能改本地文件：未下载的歌曲 filePath 为空（旧数据里还可能是远程路径），
    // 直接弹编辑器会去读写一个根本不在本地的文件。
    if (!filePath) {
      toast('请先下载歌曲，再编辑标签')
      return
    }
    void existsFile(filePath).then((exists) => {
      if (!exists) {
        toast('本地文件不存在，请先下载', 'long')
        return
      }
      selectedMusicInfoRef.current = info.musicInfo
      metadataEditTypeRef.current?.show(filePath, info.musicInfo)
    })
  }, [])

  const handleUpdateMetadata = useCallback(() => {
    if (!selectedMusicInfoRef.current) return
    loadConfig().catch(() => {})
  }, [loadConfig])

  const handleRemove = useCallback((info: WebDAVSelectInfo) => {
    // W16：菜单写的是「从列表移除」——确认框把范围说清：不删服务器文件、
    // 不删已下载的本地文件，重新扫描还会回来
    void confirmDialog({
      title: '从列表移除',
      message: `将《${info.musicInfo.name}》从列表中移除。不会删除服务器上的文件，也不会删除已下载到本地的文件；重新扫描后它还会出现。`,
      cancelButtonText: '取消',
      confirmButtonText: '移除',
    }).then((confirmed) => {
      if (!confirmed) return
      void handleWebDAVRemove(info.musicInfo).then((success) => {
        // P1-13：只在真正删除成功时更新 UI，避免持久化失败时 UI 与数据不一致
        if (success) {
          setSongs(prevSongs => prevSongs.filter(song => song.id !== info.musicInfo.id))
        }
      })
    })
  }, [])

  const handleBatchDownload = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    void confirmDialog({
      title: '扫描并下载',
      message: '此操作将先扫描 WebDAV 目录，然后下载所有扫描到的歌曲。下载后的歌曲将添加到下载列表中，并自动读取音乐标签。',
      confirmButtonText: '开始扫描并下载',
    }).then((confirmed) => {
      if (!confirmed) return

      setLoading(true)
      setScanText('开始扫描...')
      scanCancelRef.current = false
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      }, () => scanCancelRef.current)
        .then(({ config, cancelled }) => {
          const scannedSongs = config.songs ?? []
          setSongs(scannedSongs)
          if (!cancelled) setScannedAt(config.scannedAt)
          setScanText('')

          // 中-4：扫描阶段被取消就到此为止——此前照常进入下载，且下载入口会把
          // 取消令牌复位，用户的取消被彻底抹掉
          if (cancelled) {
            toast('已取消扫描，未开始下载')
            return
          }

          if (scannedSongs.length === 0) {
            toast('没有扫描到可下载的歌曲')
            return
          }

          void handleWebDAVDownloadAndImport(scannedSongs, setBatchLoadingText)
        })
        .catch((err: any) => {
          webDAVLog.warn('[WebDAV] 扫描并下载失败', { error: err?.message ?? err })
          const message = friendlyWebDAVError(err)
          setScanTextTemp(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    })
  }, [hasConfig, selectedFolder])

  // 列表头「上传」按钮：跳上传 tab（守卫在 selectTab 里）
  const handleUpload = useCallback(() => {
    selectTab('upload')
  }, [selectTab])

  // ================= 搜索 =================

  const handleToggleSearch = useCallback(() => {
    setSearchVisible((visible) => {
      const nextVisible = !visible
      if (nextVisible) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
        })
      } else {
        setSearchText('')
        Keyboard.dismiss()
      }
      return nextVisible
    })
  }, [])

  const handleClearSearch = useCallback(() => {
    if (searchText) {
      setSearchText('')
      searchInputRef.current?.focus()
      return
    }
    setSearchVisible(false)
    Keyboard.dismiss()
  }, [searchText])

  // ================= 定位 =================

  const scrollToMusic = useCallback((musicId: string) => {
    let list = filteredSongs
    let index = list.findIndex(item => item.id === musicId)
    // 中：定位不在当前筛选/搜索范围内的歌时，要同时解除目录筛选——
    // 此前只清搜索词，filterPath 还在就拿全量下标对过滤列表 scrollToIndex，
    // 跳错歌或走失败兜底乱跳
    if (index < 0 && (searchText || filterPath)) {
      if (searchText) setSearchText('')
      if (filterPath) setFilterPath(null)
      list = songs
      index = list.findIndex(item => item.id === musicId)
    }
    if (index < 0) return
    setActiveTab('list')
    requestAnimationFrame(() => {
      setTimeout(() => {
        // P0-2：scrollToIndex 越界会抛 "scrollToIndex out of range"，在 timer 回调里未捕获
        // 会导致 JS 线程崩溃。调用前用当前列表长度 clamp，并 try/catch 兜底。
        try {
          const list = listRef.current
          if (!list) return
          // 用 ref 获取当前列表长度（闭包里的 list 可能已过期）
          listRef.current?.scrollToIndex({
            index,
            viewPosition: 0.3,
            animated: true,
          })
        } catch (e: any) {
          webDAVLog.warn('[WebDAV] scrollToIndex 失败（越界）', { index, error: e?.message })
        }
      }, searchText ? 160 : 80)
    })
  }, [filteredSongs, searchText, songs, filterPath])

  // ================= effects =================

  useEffect(() => {
    // P1-14：加 catch，存储损坏时给用户提示而不是静默白屏
    loadConfig().catch((err: any) => {
      webDAVLog.error('[WebDAV] 首屏加载配置失败', { error: err?.message ?? err })
      toast(`加载 WebDAV 配置失败：${err?.message ?? err}`, 'long')
    })
  }, [loadConfig])

  useEffect(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  // 文件 App 选的临时文件由 useUploadManager 在终态/移除/清空时删除，
  // 不再需要页面级的"离开 tab 清理"（旧逻辑，新管理器已接管）。

  useEffect(() => {
    const handleWebdavPicUpdated = (musicId: string, picUrl: string) => {
      patchSongInList(musicId, song => ({ ...song, meta: { ...song.meta, picUrl } }))
    }

    global.app_event.on('webdavPicUpdated', handleWebdavPicUpdated)
    return () => {
      global.app_event.off('webdavPicUpdated', handleWebdavPicUpdated)
    }
  }, [patchSongInList])

  useEffect(() => {
    const handleJumpPosition = () => {
      const rawMusicInfo = playerState.playMusicInfo.musicInfo
      const musicInfo = rawMusicInfo && 'progress' in rawMusicInfo ? rawMusicInfo.metadata.musicInfo : rawMusicInfo
      if (!musicInfo) return
      pendingJumpIdRef.current = musicInfo.id
      scrollToMusic(musicInfo.id)
    }
    global.app_event.on('jumpWebDAVPosition', handleJumpPosition)
    return () => {
      global.app_event.off('jumpWebDAVPosition', handleJumpPosition)
    }
  }, [scrollToMusic])

  useEffect(() => {
    if (activeTab !== 'list' || !pendingJumpIdRef.current) return
    const musicId = pendingJumpIdRef.current
    pendingJumpIdRef.current = null
    scrollToMusic(musicId)
  }, [activeTab, scrollToMusic])

  // ================= 导出 =================

  return {
    // tab
    activeTab, selectTab,
    // 播放
    playMusicInfo: playMusicInfo.musicInfo,
    // 配置
    hasConfig, isTesting,
    webdavUrl, webdavUsername, webdavPassword, webdavMediaSource,
    handleWebdavSettingChanged, handleWebdavMediaSourceChanged, handleTestConnection,
    // 目录
    folderStack, folders, folderLoading, currentFolder, selectedFolder,
    enterFolder, goBackFolder, handleSelectCurrentFolder, handleRefreshFolders,
    songFolders, filterPath, handleSetFilterPath,
    // 列表
    loading, songs, filteredSongs, scannedAt, scanText, batchLoadingText,
    searchVisible, searchText, setSearchText,
    handleToggleSearch, handleClearSearch,
    handleScan, handleBatchDownload, handleBatchFetchCovers, handleRefresh, handleUpload, handleCancelOperation,
    handlePlay, handleLongPress, showMenu,
    // 多选
    isSelecting, selectedIds, exitSelectMode, toggleSelectAll, handleDownloadSelected,
    handleAddSelectedToPlaylist, musicMultiAddModalRef,
    listRef, searchInputRef,
    numColumns, rowWidth: rowInfo.rowWidth,
    headerText,
    // 上传（新管理器：队列/并发/真实进度/历史；旧的零散 state 已移除）
    uploadTargetDir, uploadWithLyrics, setUploadWithLyrics,
    uploadWithCover, setUploadWithCover,
    uploadManager,
    // 菜单 / 弹窗
    webDAVListMenuRef, metadataEditTypeRef, handleUpdateMetadata,
    menuHandlers: {
      onPlay: (info: WebDAVSelectInfo) => { handlePlay(info.musicInfo) },
      onPlayLater: handlePlayLater,
      onDownload: handleDownload,
      onFetchPicFromOnline: handleFetchPicFromOnline,
      onSpecifyPicFile: handleSpecifyPicFile,
      onSpecifyLrcFile: handleSpecifyLrcFile,
      onClearCustomMedia: handleClearCustomMedia,
      onEditMetadata: handleEditMetadata,
      onRemove: handleRemove,
      onLoadMetadata: handleLoadMetadata,
    },
  }
}

export type WebDAVPage = ReturnType<typeof useWebDAVPage>
