import { memo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
import { formatBriefTime, formatSize } from '../format'

const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

/**
 * WebDAV 歌曲行（从旧 index.tsx 的 SongItem 提取，渲染与样式行为不变）。
 */
export default memo(
  ({
    item,
    index,
    isPlaying,
    rowWidth = '100%',
    onPress,
    onShowMenu,
    onLongPress,
    selected = false,
    isSelecting = false,
  }: {
    item: LX.WebDAV.MusicInfo
    index: number
    isPlaying: boolean
    /** 横屏多列时每列宽度（如 '50%'），竖屏为 '100%' */
    rowWidth?: `${number}%`
    onPress: (musicInfo: LX.WebDAV.MusicInfo) => void
    onLongPress?: (musicInfo: LX.WebDAV.MusicInfo) => void
    /** 多选模式下是否被选中 */
    selected?: boolean
    /** 是否处于多选模式 */
    isSelecting?: boolean
    onShowMenu: (
      item: LX.WebDAV.MusicInfo,
      index: number,
      position: { x: number, y: number, w: number, h: number },
    ) => void
  }) => {
    const theme = useTheme()
    const moreButtonRef = useRef<TouchableOpacity>(null)
    // 没有歌手时退回展示远程路径（filePath 只表示本地已下载文件，未下载时为空）
    const subText = item.singer || item.meta.remotePath || item.meta.filePath || ''
    const sizeText = formatSize(item.meta.size)
    const timeText = formatBriefTime(item.meta.lastModifiedTime)
    const detailText = [sizeText, timeText].filter(Boolean).join(' · ')

    const handleShowMenu = () => {
      if (moreButtonRef.current?.measure) {
        moreButtonRef.current.measure((fx, fy, width, height, px, py) => {
          onShowMenu(item, index, {
            x: Math.ceil(px),
            y: Math.ceil(py),
            w: Math.ceil(width),
            h: Math.ceil(height),
          })
        })
      }
    }

    return (
      <View
        style={{
          ...styles.songItem,
          width: rowWidth,
          backgroundColor: selected
            ? theme['c-primary-background-hover']
            : isPlaying
              ? theme['c-primary-background-hover']
              : theme['c-content-background'],
          borderColor: selected || isPlaying
            ? theme['c-primary-background-active']
            : theme['c-border-background'],
        }}
      >
        <TouchableOpacity
          style={styles.songItemLeft}
          onPress={() => { onPress(item) }}
          onLongPress={() => { onLongPress?.(item) }}
          delayLongPress={400}
        >
          {/* 多选模式：显示勾选框 */}
          {isSelecting ? (
            <View style={styles.checkbox}>
              <Icon
                name={selected ? 'checkbox-marked' : 'checkbox-blank-outline'}
                size={22}
                color={selected ? theme['c-primary-font'] : theme['c-font-label']}
              />
            </View>
          ) : null}
          <View style={styles.sn}>
            {item.meta.picUrl ? (
              <Image url={item.meta.picUrl} style={styles.albumArt} cache={false} />
            ) : (
              <View style={styles.albumArtPlaceholder} />
            )}
          </View>
          <View style={styles.itemInfo}>
            <Text
              size={designTypography.body}
              style={styles.songTitle}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
              numberOfLines={1}
            >
              {item.name || item.meta.fileName}
            </Text>
            <View style={styles.listItemSingle}>
              <Text
                style={styles.listItemSingleText}
                size={designTypography.caption}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {subText}
              </Text>
            </View>
            {detailText ? (
              <Text
                size={designTypography.caption}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {detailText}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleShowMenu} ref={moreButtonRef} style={styles.moreButton}>
          <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={17} />
        </TouchableOpacity>
      </View>
    )
  },
)

const styles = createStyle({
  songItem: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    marginBottom: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.lg,
  },
  songItemLeft: {
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sn: {
    width: 74,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: designSpacing.xs,
    paddingRight: designSpacing.xs,
  },
  albumArtPlaceholder: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  albumArt: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
  },
  itemInfo: {
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 2,
  },
  songTitle: {
    fontWeight: '600',
  },
  listItemSingle: {
    paddingTop: 3,
    flexDirection: 'row',
  },
  listItemSingleText: {
    flexGrow: 0,
    flexShrink: 1,
    fontWeight: '400',
  },
  moreButton: {
    height: '80%',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    justifyContent: 'center',
  },
})
