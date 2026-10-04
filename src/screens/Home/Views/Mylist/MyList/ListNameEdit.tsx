import { useRef, useImperativeHandle, forwardRef, useState } from 'react'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import Text from '@/components/common/Text'
import { View } from 'react-native'
import Input, { type InputType } from '@/components/common/Input'
import { createUserList, updateUserList } from '@/core/list'
import { confirmDialog, createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import listState from '@/store/list/state'

interface NameInputType {
  setName: (text: string) => void
  getText: () => string
  focus: () => void
}
const NameInput = forwardRef<NameInputType, {}>((props, ref) => {
  const theme = useTheme()
  const [text, setText] = useState('')
  const [placeholder, setPlaceholder] = useState('')
  const inputRef = useRef<InputType>(null)

  useImperativeHandle(ref, () => ({
    getText() {
      return text.trim()
    },
    setName(text) {
      setText(text)
      setPlaceholder(text || global.i18n.t('list_create_input_placeholder'))
    },
    focus() {
      inputRef.current?.focus()
    },
  }))

  return (
    <Input
      ref={inputRef}
      placeholder={placeholder}
      value={text}
      onChangeText={setText}
      style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
    />
  )
})

export interface ListNameEditType {
  showCreate: (position: number) => void
  show: (listInfo: LX.List.UserListInfo) => void
}
const initSelectInfo = {}

export default forwardRef<ListNameEditType, {}>((props, ref) => {
  const alertRef = useRef<ConfirmAlertType>(null)
  const nameInputRef = useRef<NameInputType>(null)
  const [position, setPosition] = useState(0)
  // P0 修复：position 的 ref 镜像。showCreate/show 里 setPosition 后若同步调
  // handleShow，读到的 position state 还是旧值（新建/重命名分支错乱）。
  // 命令式路径统一读 ref，render 里的标题继续用 state。
  const positionRef = useRef(0)
  const selectedListInfo = useRef<LX.List.UserListInfo>(initSelectInfo as LX.List.UserListInfo)
  const [visible, setVisible] = useState(false)

  const handleShow = () => {
    alertRef.current?.setVisible(true)
    // P0 修复：三元分支写反了。position == -1 是重命名模式，应回显原名；
    // 新建模式应给空输入框（之前新建会带入上次重命名的残留旧名）。
    const pos = positionRef.current
    const name = pos == -1 ? (selectedListInfo.current.name ?? '') : ''
    requestAnimationFrame(() => {
      nameInputRef.current?.setName(name)
      setTimeout(() => {
        nameInputRef.current?.focus()
      }, 300)
    })
  }
  useImperativeHandle(ref, () => ({
    showCreate(position) {
      positionRef.current = position
      setPosition(position)
      if (visible) handleShow()
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShow()
        })
      }
    },
    show(listInfo) {
      positionRef.current = -1
      setPosition(-1)
      selectedListInfo.current = listInfo
      if (visible) handleShow()
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShow()
        })
      }
    },
  }))

  const handleRename = () => {
    let name = nameInputRef.current?.getText() ?? ''
    if (!name.length) return
    if (name.length > 100) name = name.substring(0, 100)
    if (positionRef.current == -1) {
      void updateUserList([{ ...selectedListInfo.current, name }])
    } else {
      void (
        listState.userList.some((l) => l.name == name)
          ? confirmDialog({
            message: global.i18n.t('list_duplicate_tip'),
          })
          : Promise.resolve(true)
      ).then((confirmed) => {
        if (!confirmed) return
        const now = Date.now()
        void createUserList(position, [{ id: `userlist_${now}`, name, locationUpdateTime: now }])
      })
    }
    alertRef.current?.setVisible(false)
  }

  return visible ? (
    <ConfirmAlert ref={alertRef} onConfirm={handleRename}>
      <View style={styles.renameContent}>
        <Text style={{ marginBottom: 5 }}>
          {position == -1 ? global.i18n.t('list_rename_title') : global.i18n.t('list_create')}
        </Text>
        <NameInput ref={nameInputRef} />
      </View>
    </ConfirmAlert>
  ) : null
})

const styles = createStyle({
  renameContent: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 290,
    borderRadius: 4,
    // paddingTop: 2,
    // paddingBottom: 2,
  },
})
