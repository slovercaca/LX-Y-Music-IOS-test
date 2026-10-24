import { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react'
import { View } from 'react-native'
import { externalStorageDirectoryPath, readDir } from '@/utils/fs'
import { createStyle, toast } from '@/utils/tools'
// import { useTranslation } from '@/plugins/i18n'
import Modal, { type ModalType } from '@/components/common/Modal'
import { useHorizontalMode } from '@/utils/hooks'

import Header from './components/Header'
import Main from './components/Main'
import Footer from './components/Footer'
import { sizeFormate } from '@/utils'
import { useTheme } from '@/store/theme/hook'
import { type PathItem } from './components/ListItem'
// import { getSelectedManagedFolder } from '@/utils/data'
// let prevPath = externalStorageDirectoryPath

const parentDirInfo = new Map<string, string>()
const caches = new Map<string, { at: number, list: PathItem[] }>()

const handleReadDir = async(
  path: string,
  dirOnly: boolean,
  filter?: string[],
  isRefresh = false,
) => {
  let filterRxp = filter?.length ? new RegExp(`\\.(${filter.join('|')})$`, 'i') : null
  const cacheKey = `${path}_${dirOnly ? 'true' : 'false'}_${filter ? filter.toString() : 'null'}`
  // 低：目录缓存加 30 秒 TTL——此前永不过期，新建/删除的文件在选择器里
  // 一直看不见/删不掉（只能靠手动刷新）
  if (!isRefresh) {
    const cached = caches.get(cacheKey)
    if (cached && Date.now() - cached.at < 30000) return cached.list
  }
  return readDir(path).then((paths) => {
    // console.log('read')
    // prevPath = path
    let list = [] as PathItem[]
    // console.log(paths)
    for (const path of paths) {
      // console.log(path)
      if (filterRxp != null && path.isFile && !filterRxp.test(path.name)) continue

      const isDirectory = path.isDirectory
      if (dirOnly) {
        list.push({
          name: path.name,
          path: path.path,
          mtime: new Date(path.lastModified),
          size: path.size,
          isDir: isDirectory,
          sizeText: isDirectory ? '' : sizeFormate(path.size ?? 0),
          disabled: path.isFile,
        })
      } else {
        list.push({
          name: path.name,
          path: path.path,
          mtime: new Date(path.lastModified),
          size: path.size,
          isDir: isDirectory,
          sizeText: isDirectory ? '' : sizeFormate(path.size ?? 0),
        })
      }
    }

    list.sort((a, b) => a.name.charCodeAt(0) - b.name.charCodeAt(0))
    let fileList = [] as PathItem[]
    list = [
      ...list.filter((i) => {
        if (i.isDir) return true
        else {
          fileList.push(i)
          return false
        }
      }),
      ...fileList,
    ]
    caches.set(cacheKey, { at: Date.now(), list })
    return list
  })
}

interface ReadOptions {
  title: string
  dirOnly: boolean
  filter?: string[]
}
const initReadOptions = {}
export interface ListProps {
  onConfirm: (path: string) => void
  onHide?: () => void
}

export interface ListType {
  show: (title: string, dir?: string, dirOnly?: boolean, filter?: string[]) => void
  hide: () => void
}

export default forwardRef<ListType, ListProps>(
  ({ onConfirm, onHide = () => {} }: ListProps, ref) => {
    const [path, setPath] = useState('')
    const [list, setList] = useState<PathItem[]>([])
    const isUnmountedRef = useRef(true)
    const readOptions = useRef<ReadOptions>(initReadOptions as ReadOptions)
    const [isReading, setIsReading] = useState(false)
    const readSeqRef = useRef(0)
    const modalRef = useRef<ModalType>(null)
    const theme = useTheme()
    const isHorizontal = useHorizontalMode()

    useImperativeHandle(ref, () => ({
      show(title, dir = '', dirOnly = false, filter) {
        readOptions.current = {
          title,
          dirOnly,
          filter,
        }
        modalRef.current?.setVisible(true)
        // void getSelectedManagedFolder().then(uri => {
        //   if (!uri) return
        //   void readDir(uri, dirOnly, filter)
        // })
        if (dir) void readDir(dir, dirOnly, filter)
        else void readDir(externalStorageDirectoryPath, dirOnly, filter)
      },
      hide() {
        modalRef.current?.setVisible(false)
      },
    }))

    useEffect(() => {
      isUnmountedRef.current = false
      return () => {
        isUnmountedRef.current = true
      }
    }, [])

    const readDir = async(
      newPath: string,
      dirOnly: boolean,
      filter?: string[],
      isRefresh?: boolean,
      isOpen?: boolean,
    ): Promise<PathItem[]> => {
      // 低：序号守卫替代 isReading 状态锁——状态锁拦不住并发（setState
      // 落地前连点可穿透），且被拦的导航直接丢弃；旧目录迟到结果还会
      // 覆盖新目录。改为后发为准：只有最新一次读的结果能上屏。
      const seq = ++readSeqRef.current
      setIsReading(true)
      return handleReadDir(newPath, dirOnly, filter, isRefresh)
        .then((list) => {
          if (isUnmountedRef.current) return []
          if (seq !== readSeqRef.current) return []
          if (!isOpen && newPath != path && newPath.startsWith(path)) { parentDirInfo.set(newPath, path) }
          setList(list)
          setPath(newPath)
          return list
        })
        .catch((err: any) => {
          if (seq !== readSeqRef.current) return []
          toast(`Read dir error: ${err.message as string}`, 'long')
          return []
        })
        .finally(() => {
          if (seq === readSeqRef.current) setIsReading(false)
        })
    }

    const onSetPath = (pathInfo: PathItem) => {
      // console.log('onSetPath')
      if (pathInfo.isDir) {
        void readDir(pathInfo.path, readOptions.current.dirOnly, readOptions.current.filter)
      } else {
        onConfirm(pathInfo.path)
        // setPath(pathInfo.path)
      }
    }
    const handleConfirm = () => {
      if (!path) return
      onConfirm(path)
    }

    const toParentDir = () => {
      const parentPath = parentDirInfo.get(path)
      if (parentPath) {
        void readDir(parentPath, readOptions.current.dirOnly, readOptions.current.filter)
      } else {
        toast('Permission denied')
      }
    }

    const handleHide = () => {
      modalRef.current?.setVisible(false)
      onHide()
    }

    // const dirList = useMemo(() => [parentDir, ...list], [list, parentDir])

    return (
      <Modal ref={modalRef} bgHide={false} statusBarPadding={false}>
        <View
          style={{
            ...styles.container,
            backgroundColor: theme['c-content-background'],
            width: '100%',
            maxWidth: isHorizontal ? 760 : undefined,
            alignSelf: isHorizontal ? 'center' : undefined,
          }}
        >
          <Header
            onRefreshDir={async(path) =>
              readDir(path, readOptions.current.dirOnly, readOptions.current.filter, true)
            }
            onOpenDir={async(path) =>
              readDir(path, readOptions.current.dirOnly, readOptions.current.filter, false, true)
            }
            title={readOptions.current.title}
            path={path}
          />
          <Main list={list} toParentDir={toParentDir} onSetPath={onSetPath} loading={isReading} />
          <Footer
            onConfirm={handleConfirm}
            onHide={handleHide}
            dirOnly={readOptions.current.dirOnly}
          />
        </View>
      </Modal>
    )
  },
)

const styles = createStyle({
  container: {
    flex: 1,
  },
})
