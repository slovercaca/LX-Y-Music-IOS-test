import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FlatList, TouchableOpacity, View } from 'react-native'
import Dialog, { type DialogType } from '@/components/common/Dialog'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import CheckBox from '@/components/common/CheckBox'
import { useTheme } from '@/store/theme/hook'
import { useDownloadTasks } from '@/store/download/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH, scaleSizeW } from '@/utils/pixelRatio'
import type { WebDAVUploadItem } from '@/core/webdavMusic/drive'

export interface WebDAVUploadSelectType {
  /** 打开多选弹窗；onConfirm 收到选中的上传项（空数组表示用户未选直接确认） */
  show: (onConfirm: (items: WebDAVUploadItem[]) => void) => void
}

const styles = createStyle({
  list: {
    maxHeight: scaleSizeH(360),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: scaleSizeH(9),
    paddingHorizontal: scaleSizeW(4),
  },
  rowText: {
    flex: 1,
    marginLeft: scaleSizeW(10),
  },
  sizeText: {
    marginTop: scaleSizeH(2),
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: scaleSizeH(12),
  },
  footerButton: {
    marginLeft: scaleSizeW(10),
    paddingHorizontal: scaleSizeW(18),
  },
  empty: {
    paddingVertical: scaleSizeH(30),
    alignItems: 'center',
  },
})

const formatSize = (size?: number) => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 从下载列表多选本地音频文件，用于上传到 WebDAV */
export default forwardRef<WebDAVUploadSelectType, {}>((props, ref) => {
  const theme = useTheme()
  const dialogRef = useRef<DialogType>(null)
  const onConfirmRef = useRef<(items: WebDAVUploadItem[]) => void>(() => {})
  const tasks = useDownloadTasks()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 已完成且有本地文件的下载任务才可上传
  const uploadableTasks = useMemo(
    () => tasks.filter(t => t.status === 'completed' && t.filePath && t.fileName),
    [tasks],
  )

  useImperativeHandle(ref, () => ({
    show(onConfirm) {
      onConfirmRef.current = onConfirm ?? (() => {})
      setSelectedIds(new Set())
      requestAnimationFrame(() => dialogRef.current?.setVisible(true))
    },
  }))

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === uploadableTasks.length) return new Set<string>()
      return new Set(uploadableTasks.map(t => t.id))
    })
  }, [uploadableTasks])

  const handleConfirm = useCallback(() => {
    const items: WebDAVUploadItem[] = uploadableTasks
      .filter(t => selectedIds.has(t.id))
      .map(t => ({
        localPath: t.filePath,
        fileName: t.fileName,
        size: t.progress?.total || 0,
      }))
    dialogRef.current?.setVisible(false)
    onConfirmRef.current(items)
  }, [uploadableTasks, selectedIds])

  const renderItem = useCallback(({ item }: { item: (typeof uploadableTasks)[number] }) => {
    const checked = selectedIds.has(item.id)
    return (
      <TouchableOpacity style={styles.row} onPress={() => toggle(item.id)} activeOpacity={0.7}>
        <CheckBox check={checked} onChange={() => toggle(item.id)} variant="plain" />
        <View style={styles.rowText}>
          <Text numberOfLines={1}>{item.fileName}</Text>
          <Text size={11} color={theme['c-font-label']} style={styles.sizeText} numberOfLines={1}>
            {[formatSize(item.progress?.total), item.musicInfo.singer].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </TouchableOpacity>
    )
  }, [selectedIds, theme, toggle])

  return (
    <Dialog
      ref={dialogRef}
      title="选择要上传的歌曲"
      onHide={() => setSelectedIds(new Set())}
    >
      {uploadableTasks.length === 0 ? (
        <View style={styles.empty}>
          <Text color={theme['c-font-label']}>没有已下载完成的歌曲{'\n'}请先去「下载管理」下载，或用「从文件 App 选择」</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity style={styles.row} onPress={toggleAll} activeOpacity={0.7}>
            <CheckBox
              check={selectedIds.size === uploadableTasks.length && uploadableTasks.length > 0}
              onChange={toggleAll}
              variant="plain"
            />
            <View style={styles.rowText}>
              <Text>全选（{uploadableTasks.length} 首）</Text>
            </View>
          </TouchableOpacity>
          <FlatList
            style={styles.list}
            data={uploadableTasks}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            extraData={selectedIds}
          />
        </>
      )}
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          onPress={() => dialogRef.current?.setVisible(false)}
        >
          <Text>取消</Text>
        </Button>
        <Button
          style={{ ...styles.footerButton, backgroundColor: theme['c-button-background'] }}
          disabled={selectedIds.size === 0}
          onPress={handleConfirm}
        >
          <Text color={theme['c-button-font']}>
            {selectedIds.size > 0 ? `上传 ${selectedIds.size} 首` : '上传'}
          </Text>
        </Button>
      </View>
    </Dialog>
  )
})
