import ChoosePath, { type ReadOptions, type ChoosePathType } from '@/components/common/ChoosePath'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

export interface FileSelectType {
  show: (options: ReadOptions, onSelect: typeof noop) => void
}
const noop = (_path: string) => {}
export default forwardRef<FileSelectType, {}>((props, ref) => {
  const [visible, setVisible] = useState(false)
  const choosePathRef = useRef<ChoosePathType>(null)
  const onSelectRef = useRef<typeof noop>(noop)
  // console.log('render import export')

  useImperativeHandle(ref, () => ({
    show(options, onSelect) {
      onSelectRef.current = onSelect ?? noop
      if (visible) {
        choosePathRef.current?.show(options)
      } else {
        setVisible(true)
        requestAnimationFrame(() => {
          choosePathRef.current?.show(options)
        })
      }
    },
  }))

  // 2026-10-05 fix（P1-1）：包一层闭包，调用时再读 ref——visible 已为 true 时
  // 再次 show() 不触发重渲染，直接传 onSelectRef.current 会拿到旧回调
  return visible ? <ChoosePath ref={choosePathRef} onConfirm={(path) => onSelectRef.current(path)} /> : null
})
