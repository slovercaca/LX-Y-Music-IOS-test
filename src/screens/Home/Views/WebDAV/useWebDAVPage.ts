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
import { webDAVLog } from '@/core/webdavMusic/logger'
import { testConnection, resetClient } from '@/utils/webdav'
import { existsFile, selectFile } from '@/utils/fs'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import {
  handleWebDAVDownload,
  handleFetchWebDAVPicFromOnline,
  handleWebDAVRemove,
  handleWebDAVDownloadAndImport,
} from './WebDAVListAction'
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
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [batchLoadingText, setBatchLoadingText] = useState('')
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)

  // ---------------- 目录浏览 ----------------
  const [folderStack, setFolderStack] = useState<LX.WebDAV.DriveFolder[]>([])
  const [folders, setFolders] = useState<LX.WebDAV.DriveFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<LX.WebDAV.DriveFolder | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const currentFolder = folderStack.at(-1) ?? null

  // ---------------- 上传 ----------------
  // 上传队列由 useUploadManager 管理（显式状态机：idle/uploading/paused）。
  // 这里只保留"同时上传歌词"开关与目标目录派生。
  const [uploadWithLyrics, setUploadWithLyrics] = useState(true)

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
        const config = await scanWebDAVSongs(selectedFolder, (count, path) => {
          setScanText(`已找到 ${count} 首，正在扫描：${path}`)
        })
        setSongs(config.songs ?? [])
        setScannedAt(config.scannedAt)
      } catch (err: any) {
        toast(err?.message ?? String(err), 'long')
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
    let index = 0
    const workers = Array.from({ length: 4 }, async() => {
      while (index < songList.length) {
        const i = index++
        const song = songList[i]
        if (song.meta.picUrl) continue
        try {
          const picUrl = await fetchWebDAVPic(song)
          if (picUrl) {
            songList[i] = { ...song, meta: { ...song.meta, picUrl } }
          }
        } catch {
          // ignore error
        }
      }
    })
    await Promise.all(workers)
    setSongs([...songList])
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
    setIsTesting(true)
    try {
      await testConnection()
      // 顶部弹窗，3.5 秒后自动消失
      toast('WebDAV 连接成功！', 'long', 'top')
    } catch (error: any) {
      toast(`WebDAV 连接失败：${error.message}`, 'long', 'top')
    } finally {
      setIsTesting(false)
    }
  }, [isTesting])

  // ================= 目录页动作 =================

  const loadFolders = useCallback((folder: LX.WebDAV.DriveFolder | null) => {
    setFolderLoading(true)
    void listWebDAVFolders(folder)
      .then(setFolders)
      .catch((err: any) => {
        const message = err.message ?? String(err)
        toast(message, 'long')
      })
      .finally(() => {
        setFolderLoading(false)
      })
  }, [])

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

  const handleScan = useCallback(() => {
    if (!hasConfig) {
      toast(global.i18n.t('webdav_upload_config_first'))
      setActiveTab('config')
      return
    }
    const runScan = () => {
      setLoading(true)
      setScanText('开始扫描...')
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          setSongs(config.songs ?? [])
          setScannedAt(config.scannedAt)
          setScanText('')
          setActiveTab('list')
          toast(`扫描完成：${config.songs.length} 首`)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    }
    if (!selectedFolder) {
      void confirmDialog({
        title: '扫描 WebDAV 根目录',
        message:
          '根目录扫描会递归读取所有子目录。文件夹很多时可能较慢。确定继续扫描根目录？',
        confirmButtonText: '继续扫描',
      }).then((confirmed) => {
        if (confirmed) runScan()
      })
      return
    }
    runScan()
  }, [hasConfig, selectedFolder])

  // 下拉刷新 = 重新读取**已下载到本地**文件的标签（联网扫描请用「扫描」按钮）。
  // 旧实现对所有歌曲都拿 meta.filePath 去 readMetadata —— 未下载时那是远程路径，
  // 必然读失败，却照样弹「标签加载完成」，看着像刷新了其实什么都没做。
  const handleRefresh = useCallback(() => {
    const localSongs = songs.filter(song => !!song.meta.filePath)
    if (!localSongs.length) {
      toast('没有已下载到本地的歌曲；联网扫描请点「扫描」', 'long')
      return
    }
    setLoading(true)
    setScanText(`正在读取 ${localSongs.length} 首本地文件的标签...`)
    void Promise.all(
      localSongs.map(async(song) => {
        if (!song.meta.filePath) return song
        try {
          const fileMetadata = await readMetadata(song.meta.filePath).catch(() => null)
          const picPath = await readPic(song.meta.filePath).catch(() => null)
          if (fileMetadata) {
            const updates: Record<string, any> = {}
            if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
            if (fileMetadata.name && !song.name) updates.name = fileMetadata.name
            if (fileMetadata.singer && !song.singer) updates.singer = fileMetadata.singer
            if (picPath) {
              const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
              updates.picUrl = newPicUrl
            }
            if (Object.keys(updates).length > 0) {
              await updateWebDAVMusicMeta(song.id, updates)
            }
          }
        } catch {
          // ignore
        }
        return song
      }),
    ).then(async() => {
      return getWebDAVConfig()
    }).then((config) => {
      setSongs(config.songs ?? [])
      setScanText('')
      toast(`已更新 ${localSongs.length} 首本地文件的标签`)
    }).catch((err: any) => {
      const message = err.message ?? String(err)
      setScanText(message)
      toast(message, 'long')
    }).finally(() => {
      setLoading(false)
    })
  }, [songs])

  // ================= 播放 / 菜单 =================

  const showMenu = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo, index: number, position: { x: number, y: number, w: number, h: number }) => {
      webDAVListMenuRef.current?.show({ musicInfo, index }, position)
    },
    [],
  )

  const handlePlay = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo) => {
      const index = songs.findIndex(item => item.id === musicInfo.id)
      if (index < 0) return
      void overwriteListMusics(LIST_IDS.TEMP, songs).then(() => {
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
    [songs, syncSongsCover],
  )

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
    void handleWebDAVDownload(info.musicInfo).then((newPicUrl) => {
      if (newPicUrl) {
        patchSongInList(info.musicInfo.id, song => ({ ...song, meta: { ...song.meta, picUrl: newPicUrl } }))
      }
    })
  }, [patchSongInList])

  const handleFetchPicFromOnline = useCallback((info: WebDAVSelectInfo) => {
    void handleFetchWebDAVPicFromOnline(info.musicInfo).then((newPicUrl) => {
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
    void handleWebDAVRemove(info.musicInfo).then(() => {
      setSongs(prevSongs => prevSongs.filter(song => song.id !== info.musicInfo.id))
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
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          const scannedSongs = config.songs ?? []
          setSongs(scannedSongs)
          setScannedAt(config.scannedAt)
          setScanText('')

          if (scannedSongs.length === 0) {
            toast('没有扫描到可下载的歌曲')
            return
          }

          void handleWebDAVDownloadAndImport(scannedSongs, setBatchLoadingText)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
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
    if (index < 0 && searchText) {
      setSearchText('')
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
  }, [filteredSongs, searchText, songs])

  // ================= effects =================

  useEffect(() => {
    loadConfig()
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
    // @ts-expect-error - jumpWebDAVPosition is a custom event
    global.app_event.on('jumpWebDAVPosition', handleJumpPosition)
    return () => {
      // @ts-expect-error - jumpWebDAVPosition is a custom event
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
    enterFolder, goBackFolder, handleSelectCurrentFolder,
    songFolders, filterPath, handleSetFilterPath,
    // 列表
    loading, songs, filteredSongs, scannedAt, scanText, batchLoadingText,
    searchVisible, searchText, setSearchText,
    handleToggleSearch, handleClearSearch,
    handleScan, handleBatchDownload, handleRefresh, handleUpload,
    handlePlay, showMenu,
    listRef, searchInputRef,
    numColumns, rowWidth: rowInfo.rowWidth,
    headerText,
    // 上传（新管理器：队列/并发/真实进度/历史；旧的零散 state 已移除）
    uploadTargetDir, uploadWithLyrics, setUploadWithLyrics,
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
