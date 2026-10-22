import { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
import { mkdir, readDir, unlink, stat } from '@/utils/fs'
import { sizeFormate } from '@/utils'
import {
  getLibraryRoot,
  getMusicDir,
  getLrcDir,
  getPictureDir,
  baseNameOf,
  findLyricForAudio,
  findPictureForAudio,
  AUDIO_EXTS,
  PIC_EXTS,
} from '@/utils/localLibrary'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useSafeAreaBottom, useBottomOverlayInset } from '@/store/common/hook'
import PageTopInset from '@/components/common/PageTopInset'
import Image from '@/components/common/Image'
import useCoverUrl from '@/utils/hooks/useCoverUrl'

/**
 * 本地与下载（2026-10-22 合并版）。
 *
 * 「下载」与「本地」不再分两个列表：下载完成的歌曲就是本地歌曲，统一在一个
 * 列表里展示与管理。数据来源合并去重：
 * - 已完成下载任务（按 filePath 与磁盘文件对齐，任务条目信息更全，优先）
 * - music/ 目录（及迁移过渡期的根目录/旧「本地」子夹）里未被任务覆盖的音频文件
 *
 * 每条都标注歌词/封面有无（lrc/、picture/ 同名文件），删除时连带清理同名
 * 歌词与封面；另提供「清理无用文件」删除无对应音频的歌词/封面。
 */

const AUDIO_EXT_SET = new Set(AUDIO_EXTS)
const PIC_EXT_SET = new Set(PIC_EXTS)

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
  /** 下载任务记录还在、但文件已被外部删除/移动（D8） */
  missing?: boolean
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
  const playMusicInfo = usePlayMusicInfo()

  const [items, setItems] = useState<MergedItem[]>([])
  const [loading, setLoading] = useState(false)
  const [taskSizes, setTaskSizes] = useState<Record<string, number>>({})

  const completedTasks = useMemo(
    () => tasks.filter(task => task.status === 'completed' && task.filePath),
    [tasks],
  )

  // 读取已完成下载文件的真实大小（progress.total 在某些场景为 0，导致页面上不显示大小）
  const completedKey = useMemo(
    () => completedTasks.map(task => task.id).join(','),
    [completedTasks],
  )
  useEffect(() => {
    let active = true
    if (completedTasks.length === 0) {
      setTaskSizes({})
      return
    }
    void Promise.all(
      completedTasks.map(async task => {
        if (!task.filePath) return null
        try {
          const info = await stat(task.filePath)
          return { id: task.id, size: info.size }
        } catch {
          return null
        }
      }),
    ).then(results => {
      if (!active) return
      const next: Record<string, number> = {}
      for (const r of results) {
        if (r) next[r.id] = r.size
      }
      setTaskSizes(next)
    })
    return () => {
      active = false
    }
  }, [completedKey])

  // 扫描本地库并与下载任务合并
  const scanLibrary = useCallback(async() => {
    setLoading(true)
    try {
      const root = getLibraryRoot()
      const musicDir = getMusicDir()
      const lrcDir = getLrcDir()
      const pictureDir = getPictureDir()
      await mkdir(musicDir).catch(() => {})
      await mkdir(lrcDir).catch(() => {})
      await mkdir(pictureDir).catch(() => {})

      // 歌词/封面基名集合（同名匹配用）
      const lrcBases = new Set<string>()
      for (const f of await readDir(lrcDir).catch(() => [])) {
        if (f.isFile && getExt(f.name) === 'lrc') lrcBases.add(baseNameOf(f.name).toLowerCase())
      }
      const picBases = new Set<string>()
      for (const f of await readDir(pictureDir).catch(() => [])) {
        if (f.isFile && PIC_EXT_SET.has(getExt(f.name))) picBases.add(baseNameOf(f.name).toLowerCase())
      }

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
          } else if (ext === 'lrc') {
            lrcBases.add(baseNameOf(f.name).toLowerCase())
          } else if (PIC_EXT_SET.has(ext)) {
            picBases.add(baseNameOf(f.name).toLowerCase())
          }
        }
      }

      const taskPaths = new Set(completedTasks.map(task => task.filePath))
      const merged: MergedItem[] = []

      // 任务条目优先（信息全：歌名/歌手/音质/原歌曲信息）
      for (const task of completedTasks) {
        const base = task.fileName.toLowerCase()
        merged.push({
          id: task.id,
          kind: 'task',
          name: task.musicInfo.name,
          singer: task.musicInfo.singer ?? '',
          path: task.filePath,
          size: 0,
          quality: task.actualQuality ?? task.quality,
          task,
          hasLyric: lrcBases.has(base),
          hasCover: picBases.has(base) || !!((task.musicInfo.meta as any)?.picUrl),
          // 文件不在任何扫描目录里 = 已被外部删除/移动，明确标记而非冒充本地歌曲（D8）
          missing: !seenPaths.has(task.filePath),
        })
      }
      // 未被任务覆盖的裸文件
      for (const file of audioFiles) {
        if (taskPaths.has(file.path)) continue
        const parsed = parseFileName(file.fileName)
        const base = baseNameOf(file.fileName).toLowerCase()
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
      setItems(merged)
    } finally {
      setLoading(false)
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
      if (item.missing) {
        toast('该歌曲文件不存在（可能已被删除或移动），可删除这条记录后重新下载', 'long')
        return
      }
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
          if (item.missing) {
            // 文件本就不存在：只删任务记录，不算失败（D8）
            if (item.kind === 'task') downloadActions.removeTask(id)
            continue
          }
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

  // 清理孤立文件：lrc/ 与 picture/ 里找不到对应音频（任务/文件基名集合）的
  const handleCleanupOrphans = useCallback(() => {
    void (async() => {
      const audioBases = new Set<string>()
      for (const item of items) {
        audioBases.add(baseNameOf(item.path.split('/').pop() || '').toLowerCase())
        if (item.task) audioBases.add(item.task.fileName.toLowerCase())
      }
      const orphans: string[] = []
      for (const dir of [getLrcDir(), getPictureDir()]) {
        for (const f of await readDir(dir).catch(() => [])) {
          if (!f.isFile) continue
          if (!audioBases.has(baseNameOf(f.name).toLowerCase())) orphans.push(f.path)
        }
      }
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
  }, [items, scanLibrary])

  const isPlayingId = playMusicInfo.musicInfo?.id

  // 音质展示：优先用词条（FLAC / Hi-Res / 臻品母带…），缺失的档位退回大写标识
  const qualityLabel = useCallback((quality?: LX.Quality | null) => {
    if (!quality) return ''
    return t(quality) || String(quality).toUpperCase()
  }, [t])

  const renderItem = useCallback(
    ({ item, index }: { item: MergedItem, index: number }) => {
      const fileSize = item.kind === 'task' ? (taskSizes[item.id] ?? item.task?.progress?.total ?? 0) : item.size
      return (
        <View style={isHorizontal ? styles.itemWrapper : null}>
          <SongRow
            title={item.name}
            subText={item.missing
              ? '文件不存在 · 可在批量管理中删除这条记录'
              : [
                item.singer,
                item.kind === 'task' ? qualityLabel(item.quality) : '',
                fileSize ? sizeFormate(fileSize) : '',
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
    [isHorizontal, isPlayingId, selectedIds, selecting, toggleSelect, handlePlay, taskSizes, qualityLabel],
  )

  const pageHeader = (
    <>
      {/* 竖屏下共享页头已含状态栏占位，这里再叠加 PageTopInset 会出现大段空白；
          仅横屏（LandscapeDetailLayout 自带页头、共享页头隐藏）需要保留 */}
      {isHorizontal ? <PageTopInset /> : null}
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
            下载的歌曲与本地歌曲已合并在一个列表；删除歌曲时会连带清理它的歌词与封面文件
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

  return (
    <LandscapeDetailLayout
      header={isHorizontal ? pageHeader : null}
      body={
        <View style={styles.listArea}>
          <FlatList
            style={styles.list}
            data={displayItems}
            ListHeaderComponent={isHorizontal ? undefined : pageHeader}
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
      }
      />
  )
})

const styles = createStyle({
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
