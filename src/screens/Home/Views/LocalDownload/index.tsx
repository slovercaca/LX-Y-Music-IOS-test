import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native'
import LandscapeDetailLayout from '@/components/LandscapeDetailLayout'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useI18n } from '@/lang'
import { createStyle, toast, confirmDialog } from '@/utils/tools'
import { useDownloadTasks } from '@/store/download/hook'
import { usePlayMusicInfo } from '@/store/player/hook'
import { overwriteListMusics } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import downloadActions from '@/store/download/action'
import { mkdir, readDir, unlink } from '@/utils/fs'
import { sizeFormate } from '@/utils'
import {
  getLibraryRoot,
  getMusicDir,
  getLrcDir,
  getPictureDir,
  baseNameOf,
  findLyricForAudio,
  findPictureForAudio,
  scanLibraryMediaFiles,
  AUDIO_EXTS,
} from '@/utils/localLibrary'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useSafeAreaBottom, useBottomOverlayInset } from '@/store/common/hook'
import PageTopInset from '@/components/common/PageTopInset'
import Image from '@/components/common/Image'
import useCoverUrl from '@/utils/hooks/useCoverUrl'
import DownloadTab from './DownloadTab'
import { consumePendingAction } from '@/core/pendingAction'

/**
 * 本地与下载（2026-10-22 合并版；2026-11-12 改为双标签）。
 *
 * 页面顶部用「本地 | 下载」切换：
 * - 本地标签以磁盘扫描为唯一准绳：只有 music/ 目录（及迁移过渡期的根目录、
 *   旧「本地」子夹）里真实扫到的音频才显示；扫到的文件若能按完整路径对上
 *   已完成下载任务，则用任务的歌名/歌手/音质等信息展示。没扫到的下载记录
 *   不再在这里冒充本地歌曲（此前任务记录与真实文件路径对不上时会同时出现
 *   「文件不存在」幻影条目与真实文件条目）。
 * - 下载标签管理全部下载任务：下载中（等待/下载/暂停/失败）与已完成分组；
 *   已完成下载记录统一在这里管理，即使对应文件已被外部删除/移动也不丢失。
 *
 * 本地条目都标注歌词/封面有无（lrc/、picture/ 同名文件），删除时连带清理
 * 同名歌词与封面；另提供「清理无用文件」删除无对应音频的歌词/封面。
 */

const AUDIO_EXT_SET = new Set(AUDIO_EXTS)

const getExt = (name: string) => {
  const ext = name.split('.').pop()
  return ext && ext != name ? ext.toLowerCase() : ''
}

const parseFileName = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf('.')
  const rawName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  if (!rawName.includes('-')) return { name: rawName.trim(), singer: '' }
  const [left, ...rest] = rawName.split('-')
  return { name: left.trim(), singer: rest.join('-').trim() }
}

interface MergedItem {
  id: string
  kind: 'task' | 'file'
  name: string
  singer: string
  path: string
  size: number
  quality?: LX.Quality | null
  task?: LX.Download.DownloadTask
  hasLyric: boolean
  hasCover: boolean
}

// 本地文件转播放器可识别结构（走 localPlay 本地播放接口）
const localFileToPlayItem = (item: MergedItem): any => ({
  id: item.id,
  name: item.name,
  singer: item.singer,
  source: 'local',
  interval: null,
  meta: {
    songId: item.path,
    albumName: '',
    filePath: item.path,
    ext: getExt(item.path),
  },
})

// 下载任务转播放器可识别结构（metadata.musicInfo 供歌词/封面/回退使用）
const taskToPlayItem = (task: LX.Download.DownloadTask): any => ({
  id: task.id,
  isComplate: true,
  status: task.status,
  statusText: '',
  downloaded: task.progress?.downloaded ?? 0,
  total: task.progress?.total ?? 0,
  progress: task.progress?.percent ?? 1,
  speed: '',
  metadata: {
    musicInfo: task.musicInfo as LX.Music.MusicInfoOnline,
    url: null,
    quality: task.quality,
    ext: (task.fileName.split('.').pop() as any) ?? 'mp3',
    fileName: task.fileName,
    filePath: task.filePath,
    // 2026-11-14 实际下载平台带进播放链路：换源下载后详情页徽章显示「原 → 实际」；
    // 未换源/旧任务为 undefined，取链层回退原平台，行为与原来一致。
    actualSource: task.actualSource,
  },
})

const SongRow = memo(
  ({
    title,
    subText,
    singer,
    coverFile,
    coverPicUrl,
    isPlaying,
    selected,
    onPress,
  }: {
    title: string
    subText: string
    singer: string
    // 本地文件路径：封面优先读文件内嵌图，其次 picture/ 缓存，再走在线匹配
    coverFile?: string
    coverPicUrl?: string | null
    isPlaying: boolean
    selected: boolean
    onPress: () => void
  }) => {
    const theme = useTheme()
    const coverSong = useMemo(() => ({
      source: 'local',
      name: title,
      singer,
      meta: { filePath: coverFile, picUrl: coverPicUrl ?? null },
    }), [title, singer, coverFile, coverPicUrl])
    const coverUrl = useCoverUrl(coverSong)
    return (
      <TouchableOpacity
        style={{
          ...styles.songItem,
          backgroundColor: isPlaying || selected
            ? theme['c-primary-background-hover']
            : theme['c-primary-light-900-alpha-200'],
          borderColor: isPlaying || selected
            ? theme['c-primary-background-active']
            : theme['c-border-background'],
        }}
        onPress={onPress}
      >
        <Image url={coverUrl} style={styles.albumArt} />
        <View style={styles.itemInfo}>
          <Text
            size={designTypography.body}
            style={styles.songTitle}
            color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text
            size={designTypography.caption}
            color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
            numberOfLines={1}
          >
            {subText}
          </Text>
        </View>
        {selected && (
          <View style={{ ...styles.selectedMark, borderColor: theme['c-primary-background-active'] }}>
            <Text size={13} color={theme['c-primary-font-active']}>
              ✓
            </Text>
          </View>
        )}
      </TouchableOpacity>
    )
  },
)

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const isHorizontal = useHorizontalMode()
  const safeAreaBottom = useSafeAreaBottom()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const tasks = useDownloadTasks()
  const tasksRef = useRef(tasks)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  const playMusicInfo = usePlayMusicInfo()

  const [items, setItems] = useState<MergedItem[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'local' | 'download'>('local')

  const completedTasks = useMemo(
    () => tasks.filter(task => task.status === 'completed' && task.filePath),
    [tasks],
  )

  // 悬浮下载球会先写入 pendingAction 再切到本页：本页若尚未挂载，靠这里消费；
  // 已经挂载时则靠下面的 app_event 直接切换。两个入口都指向「下载」标签。
  useEffect(() => {
    if (consumePendingAction('localDownloadTab') === 'download') setActiveTab('download')
    const handleShowDownloads = () => {
      // 已挂载时事件就是本次切换的凭据：把 pending 一并消费掉，
      // 免得它残留到下次挂载时又把用户手动切回的本地标签覆盖掉
      consumePendingAction('localDownloadTab')
      setActiveTab('download')
    }
    global.app_event.on('show_local_download_tab', handleShowDownloads)
    return () => {
      global.app_event.off('show_local_download_tab', handleShowDownloads)
    }
  }, [])

  const scanGenRef = useRef(0)
  // 扫描本地库并与下载任务合并
  const scanLibrary = useCallback(async() => {
    // 低-11：代际守卫——多次扫描重叠时只认最新一次结果，防旧结果后到覆写
    const gen = ++scanGenRef.current
    setLoading(true)
    try {
      const root = getLibraryRoot()
      const musicDir = getMusicDir()
      const lrcDir = getLrcDir()
      const pictureDir = getPictureDir()
      await mkdir(musicDir).catch(() => {})
      await mkdir(lrcDir).catch(() => {})
      await mkdir(pictureDir).catch(() => {})

      // 歌词/封面指示（2026-11-12）：递归直扫整个本地库（lrc/、picture/ 及其
      // 各级子目录），扫到了就是有、没扫到就是没有；每次点「刷新」都会重新扫
      // 一次。递归口径与播放查找（同目录 → 子目录 → 父目录兄弟目录）一致——
      // 此前只读 lrc/、picture/ 顶层 + 几个顶层目录的散落文件，漏掉了子目录
      // 里的缓存文件，造成「本地明明缓存到了、列表却显示没有」。
      const { lrcBases, picBases } = await scanLibraryMediaFiles()

      // 音频来源：music/ 为主；根目录平铺与旧「本地」子夹是迁移过渡期的遗留，一并纳入
      const audioFiles: Array<{ path: string, fileName: string, size: number }> = []
      const seenPaths = new Set<string>()
      for (const dir of [musicDir, root, `${root}/本地`]) {
        for (const f of await readDir(dir).catch(() => [])) {
          if (!f.isFile) continue
          const ext = getExt(f.name)
          if (AUDIO_EXT_SET.has(ext)) {
            if (!seenPaths.has(f.path)) {
              seenPaths.add(f.path)
              audioFiles.push({ path: f.path, fileName: f.name, size: f.size })
            }
          }
        }
      }

      // 本地列表只从「扫到的真实文件」生成条目：已完成任务仅在完整路径命中
      // 扫到的文件时提供更完整的歌名/歌手/音质信息。没扫到的任务记录不进入
      // 本地列表——它可能只是路径与真实落盘位置对不上，记录本身去「下载」
      // 标签的已完成分组里管理，不在这里生成一条点不开的幻影。
      const completedTaskByPath = new Map(completedTasks.map(task => [task.filePath, task]))
      const merged: MergedItem[] = []
      const unfinishedTaskPaths = new Set(
        tasksRef.current.filter(task => task.status !== 'completed').map(task => task.filePath).filter(Boolean),
      )
      for (const file of audioFiles) {
        // 中-23：下载中的临时文件（*.download.*）与失败/暂停任务的半截文件不是
        // 完整歌曲，不能当本地歌展示（点播会半截断、还会多出怪名条目）
        if (file.fileName.includes('.download.')) continue
        if (unfinishedTaskPaths.has(file.path)) continue
        const base = baseNameOf(file.fileName).toLowerCase() // 中：集合里存的是去扩展名基名，此前带扩展名比对永远命不中、任务歌恒显示「无歌词/封面」
        const task = completedTaskByPath.get(file.path)
        if (task) {
          merged.push({
            id: task.id,
            kind: 'task',
            name: task.musicInfo.name,
            singer: task.musicInfo.singer ?? '',
            path: file.path,
            size: file.size,
            quality: task.actualQuality ?? task.quality,
            task,
            hasLyric: lrcBases.has(base),
            // 指示只看本地扫描结果：任务自带的在线封面地址不算「有封面」，
            // 否则没缓存到本地的歌也会显示有封面、与扫描口径不一致
            hasCover: picBases.has(base),
          })
          continue
        }
        const parsed = parseFileName(file.fileName)
        merged.push({
          id: `localdl_${file.path}`,
          kind: 'file',
          name: parsed.name,
          singer: parsed.singer,
          path: file.path,
          size: file.size,
          hasLyric: lrcBases.has(base),
          hasCover: picBases.has(base),
        })
      }
      merged.sort((a, b) => a.name.localeCompare(b.name))
      if (gen === scanGenRef.current) setItems(merged)
    } finally {
      if (gen === scanGenRef.current) setLoading(false)
    }
  }, [completedTasks])

  useEffect(() => {
    void scanLibrary()
  }, [scanLibrary])

  const handleRefresh = useCallback(() => {
    if (loading) return
    void scanLibrary().then(() => {
      toast('已刷新', 'short')
    })
  }, [loading, scanLibrary])

  const [keyword, setKeyword] = useState('')
  const displayItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return items
    return items.filter(i => i.name.toLowerCase().includes(kw) || i.singer.toLowerCase().includes(kw))
  }, [items, keyword])

  const handlePlay = useCallback(
    (item: MergedItem, index: number) => {
      const playListData = displayItems.map(i => (i.kind === 'task' && i.task ? taskToPlayItem(i.task) : localFileToPlayItem(i)))
      void overwriteListMusics(LIST_IDS.TEMP, playListData).then(() => {
        void playList(LIST_IDS.TEMP, index)
      })
    },
    [displayItems],
  )

  // 迁移一次性提示（D17）：启动迁移搬过文件时，进本页弹一次说明，安抚「歌丢了」的误会
  useEffect(() => {
    void (async() => {
      try {
        const { getData, saveData } = await import('@/plugins/storage')
        const noticed = await getData<boolean>('library_structure_migrated_notice')
        if (noticed) {
          await saveData('library_structure_migrated_notice', false)
          toast('本地歌曲已整理到新文件夹（歌曲、歌词、封面分开存放），文件没有丢失', 'long')
        }
      } catch {}
    })()
  }, [])

  // 批量管理模式：点击行改为切换选中，底部出现 全选 / 已选 / 删除 操作栏
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const enterSelecting = useCallback(() => {
    setSelecting(true)
    setSelectedIds(new Set())
  }, [])

  const exitSelecting = useCallback(() => {
    setSelecting(false)
    setSelectedIds(new Set())
  }, [])

  // 切标签时退出本地批量选择：选择栏是本地列表的悬浮层，不能带到下载标签上
  const switchTab = useCallback((tab: 'local' | 'download') => {
    if (activeTab !== tab) exitSelecting()
    setActiveTab(tab)
  }, [activeTab, exitSelecting])

  // 下载球经 app_event 切标签时没有走 switchTab，这里统一兜底退出批量选择
  useEffect(() => {
    if (activeTab !== 'local' && selecting) exitSelecting()
  }, [activeTab, selecting, exitSelecting])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    const allIds = displayItems.map(i => i.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id))
    setSelectedIds(allSelected ? new Set() : new Set(allIds))
  }, [displayItems, selectedIds])

  // 删除选中：音频 + 同名歌词（lrc/）+ 同名封面（picture/）一并清理；
  // 任务条目同时移除下载任务记录。失败如实报告，不假装成功。
  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    void confirmDialog({
      message: `确定删除选中的 ${ids.length} 首歌曲吗？同名歌词与封面会一并删除，此操作不可恢复。`,
    }).then(async(confirmed) => {
      if (!confirmed) return
      let failed = 0
      for (const id of ids) {
        const item = items.find(i => i.id === id)
        if (!item) continue
        try {
          await unlink(item.path)
          const lrcPath = await findLyricForAudio(item.path).catch(() => null)
          if (lrcPath) await unlink(lrcPath).catch(() => {})
          const picPath = await findPictureForAudio(item.path).catch(() => null)
          if (picPath) await unlink(picPath).catch(() => {})
          if (item.kind === 'task') downloadActions.removeTask(id)
        } catch {
          failed++
        }
      }
      if (failed > 0) toast(`已删除 ${ids.length - failed} 首，${failed} 首删除失败`, 'short')
      else toast('已删除', 'short')
      exitSelecting()
      void scanLibrary()
    })
  }, [selectedIds, items, exitSelecting, scanLibrary])

  // 清理孤立文件：与指示同一口径，递归扫出的全部歌词/封面文件里，找不到
  // 对应音频（递归音频基名集合，含子目录里的歌）的即孤立。不能只按列表里的
  // 歌判定——列表只展示顶层音频，子目录歌曲的歌词/封面会被误判孤立删掉。
  const handleCleanupOrphans = useCallback(() => {
    void (async() => {
      const { lrcFiles, picFiles, audioBases } = await scanLibraryMediaFiles()
      const orphans = [...lrcFiles, ...picFiles].filter(p =>
        !audioBases.has(baseNameOf(p.split('/').pop() || '').toLowerCase()),
      )
      if (!orphans.length) {
        toast('没有无用的歌词/封面文件', 'short')
        return
      }
      const confirmed = await confirmDialog({
        message: `发现 ${orphans.length} 个没有对应歌曲的歌词/封面文件，确定删除吗？此操作不可恢复。`,
      })
      if (!confirmed) return
      let failed = 0
      for (const p of orphans) {
        try {
          await unlink(p)
        } catch {
          failed++
        }
      }
      if (failed > 0) toast(`已清理 ${orphans.length - failed} 个，${failed} 个删除失败`, 'short')
      else toast(`已清理 ${orphans.length} 个无用文件`, 'short')
      void scanLibrary()
    })()
  }, [scanLibrary])

  const isPlayingId = playMusicInfo.musicInfo?.id

  // 音质展示：优先用词条（FLAC / Hi-Res / 臻品母带…），缺失的档位退回大写标识
  const qualityLabel = useCallback((quality?: LX.Quality | null) => {
    if (!quality) return ''
    return t(quality) || String(quality).toUpperCase()
  }, [t])

  const renderItem = useCallback(
    ({ item, index }: { item: MergedItem, index: number }) => {
      return (
        <View style={isHorizontal ? styles.itemWrapper : null}>
          <SongRow
            title={item.name}
            subText={[
              item.singer,
              item.kind === 'task' ? qualityLabel(item.quality) : '',
              item.size ? sizeFormate(item.size) : '',
              item.hasLyric ? '有歌词' : '无歌词',
              item.hasCover ? '有封面' : '无封面',
            ]
              .filter(Boolean)
              .join(' · ')}
            singer={item.singer}
            coverFile={item.path}
            coverPicUrl={item.task ? ((item.task.musicInfo.meta as any)?.picUrl ?? null) : null}
            isPlaying={isPlayingId == item.id}
            selected={selectedIds.has(item.id)}
            onPress={() => { selecting ? toggleSelect(item.id) : handlePlay(item, index) }}
          />
        </View>
      )
    },
    [isHorizontal, isPlayingId, selectedIds, selecting, toggleSelect, handlePlay, qualityLabel],
  )

  const activeTaskCount = tasks.filter(task => task.status !== 'completed').length

  const tabHeader = (
    <>
      {/* 竖屏下共享页头已含状态栏占位，这里再叠加 PageTopInset 会出现大段空白；
          仅横屏（LandscapeDetailLayout 自带页头、共享页头隐藏）需要保留 */}
      {isHorizontal ? <PageTopInset /> : null}
      <View style={{ ...styles.tabBar, backgroundColor: theme['c-primary-light-900-alpha-200'] }}>
        <TouchableOpacity
          style={{ ...styles.tabBtn, backgroundColor: activeTab === 'local' ? theme['c-primary-background'] : 'transparent' }}
          onPress={() => { switchTab('local') }}
        >
          <Text size={designTypography.body} color={activeTab === 'local' ? theme['c-primary-font'] : theme['c-font-label']}>
            本地
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{ ...styles.tabBtn, backgroundColor: activeTab === 'download' ? theme['c-primary-background'] : 'transparent' }}
          onPress={() => { switchTab('download') }}
        >
          <View style={styles.tabLabelRow}>
            <Text size={designTypography.body} color={activeTab === 'download' ? theme['c-primary-font'] : theme['c-font-label']}>
              下载
            </Text>
            {activeTaskCount > 0 ? (
              <View style={{ ...styles.tabBadge, backgroundColor: theme['c-primary'] }}>
                <Text size={10} color="#fff">{activeTaskCount > 99 ? '99+' : activeTaskCount}</Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>
      </View>
    </>
  )

  const localHeader = (
    <>
          <View style={styles.header}>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={{ ...styles.headerBtn, backgroundColor: theme['c-primary-background'] }}
                onPress={selecting ? exitSelecting : enterSelecting}
              >
                <Text size={designTypography.caption} color={theme['c-primary-font']}>
                  {selecting ? '取消' : '批量管理'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ ...styles.refreshBtn, backgroundColor: theme['c-primary-background'] }}
                onPress={handleCleanupOrphans}
              >
                <Text size={designTypography.caption} color={theme['c-primary-font']}>
                  清理孤立文件
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ ...styles.refreshBtn, backgroundColor: theme['c-primary-background'] }}
                onPress={handleRefresh}
              >
                <Text size={designTypography.caption} color={theme['c-primary-font']}>
                  刷新
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text size={11} color={theme['c-500']} style={styles.tip}>
            本地列表以磁盘扫描为准；下载记录在「下载」标签里管理。删除本地歌曲时会连带清理它的歌词与封面文件
          </Text>
          <View style={{ ...styles.searchWrap, borderColor: theme['c-border-background'], backgroundColor: theme['c-content-background'] }}>
            <TextInput
              style={{ ...styles.searchInput, color: theme['c-font'] }}
              placeholder="搜索本地歌曲"
              placeholderTextColor={theme['c-font-label']}
              value={keyword}
              onChangeText={setKeyword}
              returnKeyType="search"
            />
            {keyword ? (
              <TouchableOpacity onPress={() => { setKeyword('') }} style={styles.searchClear}>
                <Text size={13} color={theme['c-font-label']}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>
    </>
  )

  const pageHeader = (
    <>
      {tabHeader}
      {localHeader}
    </>
  )

  return (
    <LandscapeDetailLayout
      header={isHorizontal ? (activeTab === 'local' ? pageHeader : tabHeader) : null}
      body={activeTab === 'download' ? (
        <View style={styles.listArea}>
          {isHorizontal ? null : tabHeader}
          <DownloadTab bottomInset={bottomInset} />
        </View>
      ) : (
        <View style={styles.listArea}>
          {/* 竖屏：标签栏固定在列表上方（照酷狗，滚动时不跟着列表跑掉）；
              横屏标签栏在 LandscapeDetailLayout 的固定页头里，这里不重复 */}
          {isHorizontal ? null : tabHeader}
          <FlatList
            style={styles.list}
            data={displayItems}
            ListHeaderComponent={isHorizontal ? undefined : localHeader}
            contentContainerStyle={{ paddingBottom: bottomInset }}
            key={isHorizontal ? 'horizontal' : 'vertical'}
            numColumns={isHorizontal ? 2 : 1}
            columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
            keyExtractor={item => item.id}
            // 限制渲染窗口 + 离屏行视图摘除（iOS 滚动掉帧主杠杆）
            initialNumToRender={20}
            windowSize={5}
            maxToRenderPerBatch={10}
            removeClippedSubviews={true}
            updateCellsBatchingPeriod={50}
            renderItem={renderItem}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text color={theme['c-500']}>{loading ? '正在扫描...' : keyword.trim() ? '没有找到匹配的歌曲' : '还没有本地歌曲'}</Text>
              </View>
            }
          />

          {selecting && (
            <View
              style={[
                styles.selectBar,
                {
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme['c-border-background'],
                  backgroundColor: theme['c-content-background'],
                  // 悬浮在迷你播放器胶囊上方：胶囊 + tab 栏最高约到 safeAreaBottom + 150
                  bottom: 160 + safeAreaBottom,
                },
              ]}
            >
              <TouchableOpacity style={styles.selectBarBtn} onPress={toggleSelectAll}>
                <Text size={designTypography.caption} color={theme['c-primary-font']}>
                  {displayItems.length > 0 && displayItems.every(i => selectedIds.has(i.id)) ? '取消全选' : '全选'}
                </Text>
              </TouchableOpacity>
              <Text size={designTypography.caption} color={theme['c-font-label']} style={{ marginLeft: 'auto' }}>
                已选 {selectedIds.size} 项
              </Text>
              <TouchableOpacity
                style={[styles.selectBarBtn, selectedIds.size === 0 && styles.selectBarBtnDisabled]}
                onPress={handleDeleteSelected}
              >
                <Text
                  size={designTypography.caption}
                  color={selectedIds.size === 0 ? theme['c-500'] : theme['c-primary-font']}
                >
                  删除
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}
      />
  )
})

const styles = createStyle({
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: designSpacing.md,
    marginTop: designSpacing.sm,
    marginBottom: designSpacing.xs,
    padding: 3,
    borderRadius: designRadius.pill,
    gap: 3,
  },
  tabBtn: {
    flex: 1,
    height: 34,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tabBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: designSpacing.sm,
    paddingBottom: designSpacing.xs,
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
  },
  headerActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: designSpacing.sm,
  },
  headerBtn: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  refreshBtn: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  tip: {
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    paddingBottom: designSpacing.sm,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: designSpacing.md,
    marginBottom: designSpacing.sm,
    paddingHorizontal: designSpacing.sm,
    height: 36,
    borderWidth: 1,
    borderRadius: designRadius.pill,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    paddingVertical: 0,
  },
  searchClear: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  columnWrapper: {
    paddingHorizontal: 8,
  },
  itemWrapper: {
    flex: 1,
    maxWidth: '50%',
  },
  songItem: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 70,
    marginHorizontal: designSpacing.md,
    marginBottom: designSpacing.sm,
    paddingHorizontal: designSpacing.md,
    paddingVertical: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.lg,
  },
  albumArt: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
    marginRight: designSpacing.sm,
  },
  songTitle: {
    fontWeight: '600',
  },
  itemInfo: {
    flex: 1,
    gap: 4,
  },
  empty: {
    paddingTop: 60,
    alignItems: 'center',
  },
  listArea: {
    flex: 1,
    // selectBar 绝对定位的参照容器
    position: 'relative',
  },
  list: {
    flex: 1,
  },
  selectedMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: designSpacing.sm,
  },
  selectBar: {
    position: 'absolute',
    left: designSpacing.md,
    right: designSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.md,
    paddingVertical: designSpacing.sm,
    borderRadius: designRadius.pill,
    gap: designSpacing.md,
  },
  selectBarBtn: {
    paddingHorizontal: designSpacing.sm,
    paddingVertical: designSpacing.xs,
  },
  selectBarBtnDisabled: {
    opacity: 0.5,
  },
})
