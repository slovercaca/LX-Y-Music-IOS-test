import { memo } from 'react'
import { View } from 'react-native'
import { createStyle } from '@/utils/tools'
import WebDAVListMenu from './WebDAVListMenu'
import MetadataEditModal from '@/components/MetadataEditModal'
import { useWebDAVPage } from './useWebDAVPage'
import ConfigTab from './components/ConfigTab'
import FoldersTab from './components/FoldersTab'
import UploadTab from './components/UploadTab'
import ListTab from './components/ListTab'

/**
 * WebDAV 页面（重写版）。
 *
 * 四个 tab：列表 / 目录 / 上传 / 配置。
 * 全部状态与逻辑收拢在 useWebDAVPage()，这里只做装配：
 * tab 切换 + 歌曲菜单 + 标签编辑弹窗。
 */
export default memo(() => {
  const page = useWebDAVPage()
  const { activeTab, webDAVListMenuRef, metadataEditTypeRef, handleUpdateMetadata, menuHandlers } = page

  return (
    <View style={styles.container}>
      {activeTab === 'config' ? (
        <ConfigTab page={page} />
      ) : activeTab === 'folders' ? (
        <FoldersTab page={page} />
      ) : activeTab === 'upload' ? (
        <UploadTab page={page} />
      ) : (
        <ListTab page={page} />
      )}
      <WebDAVListMenu
        ref={webDAVListMenuRef}
        onPlay={menuHandlers.onPlay}
        onPlayLater={menuHandlers.onPlayLater}
        onDownload={menuHandlers.onDownload}
        onFetchPicFromOnline={menuHandlers.onFetchPicFromOnline}
        onSpecifyPicFile={menuHandlers.onSpecifyPicFile}
        onSpecifyLrcFile={menuHandlers.onSpecifyLrcFile}
        onClearCustomMedia={menuHandlers.onClearCustomMedia}
        onEditMetadata={menuHandlers.onEditMetadata}
        onRemove={menuHandlers.onRemove}
        onLoadMetadata={menuHandlers.onLoadMetadata}
      />
      <MetadataEditModal ref={metadataEditTypeRef} onUpdate={handleUpdateMetadata} />
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
})
