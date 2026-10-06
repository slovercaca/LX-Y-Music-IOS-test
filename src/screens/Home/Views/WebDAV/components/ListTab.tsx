import { memo, useCallback, useRef } from 'react'
import { FlatList, RefreshControl, StyleSheet, TextInput, TouchableOpacity, View, type ListRenderItem } from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { useBottomOverlayInset } from '@/store/common/hook'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
import SongItem from './SongItem'
import TabsHeader from './TabsHeader'
import { getFolderName } from '../format'
import type { WebDAVPage } from '../useWebDAVPage'

const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

/**
 * WebDAV「列表」tab（从旧 index.tsx 的 renderList 提取，行为不变）。
 */
export default memo(({ page }: { page: WebDAVPage }) => {
  const theme = useTheme()
  const bottomInset = useBottomOverlayInset()
  const {
    activeTab, selectTab,
    playMusicInfo,
    hasConfig, loading, filteredSongs, songs, scannedAt,
    searchVisible, searchText, setSearchText,
    handleToggleSearch, handleClearSearch,
    filterPath, handleSetFilterPath, selectedFolder,
    scanText, headerText, batchLoadingText,
    handleScan, handleBatchDownload, handleUpload, handleRefresh,
    handlePlay, handleLongPress, showMenu,
    isSelecting, selectedIds, exitSelectMode, toggleSelectAll,
    handleDownloadSelected, handleAddSelectedToPlaylist,
    listRef, searchInputRef,
    numColumns, rowWidth,
  } = page

  // P2-5（2026-10-06）：selectedIds 是每次都变的新 Set 引用，放进 useCallback deps
  // 会导致 renderSong 每次重建，SongItem 的 memo 失效。改用 ref 持有最新 Set，
  // renderSong 保持稳定；FlatList 加 extraData={selectedIds} 触发选中态重渲染，
  // memo 按 selected boolean 比对，只有真正变化的行才更新。
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds

  const renderSong: ListRenderItem<LX.WebDAV.MusicInfo> = useCallback(
    ({ item, index }) => (
      <SongItem
        item={item}
        index={index}
        isPlaying={playMusicInfo?.id === item.id}
        rowWidth={rowWidth}
        onPress={handlePlay}
        onLongPress={handleLongPress}
        selected={selectedIdsRef.current.has(item.id)}
        isSelecting={isSelecting}
        onShowMenu={showMenu}
      />
    ),
    [handlePlay, handleLongPress, showMenu, playMusicInfo?.id, rowWidth, isSelecting],
  )

  // 多选工具栏
  const selectToolbar = isSelecting ? (
    <View style={[styles.selectBar, { backgroundColor: theme['c-content-background'], borderBottomColor: theme['c-border-background'] }]}>
      <TouchableOpacity onPress={toggleSelectAll} style={styles.selectBarBtn}>
        <Text color={theme['c-primary-font']}>
          {selectedIds.size >= filteredSongs.length && filteredSongs.length > 0 ? '反选' : '全选'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleDownloadSelected}
        style={styles.selectBarBtn}
        disabled={!selectedIds.size}
      >
        <Text color={selectedIds.size ? theme['c-primary-font'] : theme['c-font-label']}>
          下载 ({selectedIds.size})
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleAddSelectedToPlaylist}
        style={styles.selectBarBtn}
        disabled={!selectedIds.size}
      >
        <Text color={selectedIds.size ? theme['c-primary-font'] : theme['c-font-label']}>
          加到歌单
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={exitSelectMode} style={styles.selectBarBtn}>
        <Text color={theme['c-font-label']}>取消</Text>
      </TouchableOpacity>
    </View>
  ) : null

  return (
    <View style={styles.listPage}>
      {selectToolbar}
      <FlatList
        key={`cols-${numColumns}`}
        ref={listRef}
        data={filteredSongs}
        ListHeaderComponent={
          <>
            <TabsHeader activeTab={activeTab} onSelect={selectTab} />
            <View style={{ ...styles.listHeader, borderBottomColor: theme['c-border-background'] }}>
              <View style={styles.listHeaderText}>
                {searchVisible ? (
                  <TextInput
                    ref={searchInputRef}
                    value={searchText}
                    placeholder="搜索歌曲或歌手"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    onChangeText={setSearchText}
                    placeholderTextColor={theme['c-font-label']}
                    selectionColor={theme['c-primary-light-100-alpha-300']}
                    style={{
                      ...styles.searchInput,
                      color: theme['c-font'],
                      borderColor: theme['c-border-background'],
                    }}
                  />
                ) : (
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text numberOfLines={1} style={{ flex: 1 }}>
                        {filterPath ? `文件夹：${filterPath.split('/').pop() || '根目录'}` : `已选择：${getFolderName(selectedFolder)}`}
                      </Text>
                      {filterPath ? (
                        <TouchableOpacity onPress={() => { handleSetFilterPath(null) }} style={{ marginLeft: 8 }}>
                          <Icon name="close" size={12} color={theme['c-primary-font']} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                      {!hasConfig ? '未配置 WebDAV：请到「配置」页填写服务器地址与用户名' : (scanText || headerText)}
                    </Text>
                  </View>
                )}
              </View>
              <TouchableOpacity style={styles.headerIconButton} onPress={handleToggleSearch}>
                <Icon name="search-2" size={16} color={searchVisible ? theme['c-primary-font'] : theme['c-font-label']} />
              </TouchableOpacity>
              {searchVisible ? (
                <TouchableOpacity style={styles.headerIconButton} onPress={handleClearSearch}>
                  <Icon name="close" size={13} color={theme['c-font-label']} />
                </TouchableOpacity>
              ) : null}
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-button-background'] }}
                disabled={loading || !!batchLoadingText}
                onPress={handleScan}
              >
                <Text color={theme['c-button-font']}>扫描</Text>
              </Button>
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-primary-background-hover'], marginLeft: 8 }}
                disabled={loading || !!batchLoadingText}
                onPress={handleBatchDownload}
              >
                <Text color={theme['c-primary-font']}>扫描并下载</Text>
              </Button>
              <Button
                style={{ ...styles.scanButton, backgroundColor: theme['c-button-background'], marginLeft: 8 }}
                disabled={loading || !!batchLoadingText}
                onPress={handleUpload}
              >
                <Text color={theme['c-button-font']}>上传</Text>
              </Button>
            </View>
          </>
        }
        contentContainerStyle={{ paddingBottom: bottomInset }}
        numColumns={numColumns}
        renderItem={renderSong}
        keyExtractor={item => item.id}
        // P2-5：选中态变化时触发重渲染（renderSong 已用 ref 解耦 selectedIds，
        // 靠 extraData 通知 FlatList；SongItem memo 按 selected boolean 比对）
        extraData={selectedIds}
        style={{ flex: 1 }}
        // 限制渲染窗口 + 离屏行视图摘除（iOS 滚动掉帧主杠杆；getItemLayout 固定行高下回挂安全）
        initialNumToRender={20}
        windowSize={5}
        maxToRenderPerBatch={10}
        removeClippedSubviews={true}
        updateCellsBatchingPeriod={50}
        getItemLayout={(data, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * Math.floor(index / numColumns),
          index,
        })}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, info.averageItemLength * info.index),
            animated: true,
          })
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text color={theme['c-font-label']}>
              {!hasConfig
                ? '未配置 WebDAV：请到「配置」页填写服务器地址与用户名'
                : searchText.trim()
                  ? '没有匹配的歌曲'
                  : '还没有扫描到歌曲，点右上角「扫描」'}
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            colors={[theme['c-primary']]}
            refreshing={loading}
            onRefresh={handleRefresh}
          />
        }
      />
    </View>
  )
})

const styles = createStyle({
  listPage: {
    flex: 1,
  },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectBarBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 60,
    alignItems: 'center',
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  listHeaderText: {
    flex: 1,
    paddingRight: 8,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    height: 34,
    paddingHorizontal: 8,
    paddingVertical: 0,
    fontSize: 13,
  },
  headerIconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButton: {
    paddingHorizontal: 12,
    // 旧按钮 paddingVertical 仅 6，触摸目标过小；统一最小高度 36，
    // 保证可点且三按钮视觉一致。
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 4,
  },
  empty: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
