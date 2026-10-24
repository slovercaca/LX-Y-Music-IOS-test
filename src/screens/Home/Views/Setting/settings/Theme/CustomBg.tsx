import { memo } from 'react'
import { View } from 'react-native'
import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'
import Text from '@/components/common/Text'
import { privateStorageDirectoryPath, mkdir, copyFile, unlink, existsFile } from '@/utils/fs'
import { launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker'

const BG_PIC_DIR = privateStorageDirectoryPath + '/backgrounds'

export default memo(() => {
  const customBgPath = useSettingValue('theme.customBgPicPath')

  const handleSelectPath = () => {
    void launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 })
      .then(async(response: ImagePickerResponse) => {
        if (response.didCancel || response.errorCode || !response.assets?.length) return

        const asset = response.assets[0]
        const uri = asset.uri
        if (!uri) return

        try {
          await mkdir(BG_PIC_DIR)

          const rawExt = asset.fileName?.split('.').pop() ??
            uri.split('.').pop()?.split('?')[0] ??
            'jpg'
          // 低：扩展名做白名单校验（防拼出含 '/' 的路径）；且先复制成功再
          // 删旧图——此前先删旧图、新图复制失败时旧背景也丢了
          const extension = /^[a-z0-9]{1,5}$/.test(rawExt.toLowerCase()) ? rawExt.toLowerCase() : 'jpg'
          const newFileName = `bg_${Date.now()}.${extension}`
          const newPath = `${BG_PIC_DIR}/${newFileName}`
          await copyFile(uri.replace(/^file:\/\//, ''), newPath)
          updateSetting({ 'theme.customBgPicPath': `file://${newPath}` })
          if (customBgPath?.startsWith('file://' + BG_PIC_DIR)) {
            const oldPath = customBgPath.replace('file://', '')
            if (oldPath !== newPath && await existsFile(oldPath)) {
              await unlink(oldPath).catch(() => {})
            }
          }
          toast('背景设置成功')
        } catch (error: any) {
          console.error('设置背景图片失败:', error)
          toast(`设置背景图片失败: ${error.message}`, 'long')
        }
      })
      .catch((error: any) => {
        console.error('打开相册失败:', error)
        toast(`打开相册失败: ${error.message}`, 'long')
      })
  }

  const handleClearPath = async() => {
    if (customBgPath?.startsWith('file://' + BG_PIC_DIR)) {
      try {
        if (await existsFile(customBgPath.replace('file://', ''))) {
          await unlink(customBgPath.replace('file://', ''))
        }
      } catch (e) {
        console.error('删除旧背景图片失败:', e)
      }
    }
    updateSetting({ 'theme.customBgPicPath': '' })
  }

  return (
    <>
      <SubTitle title={'自定义背景'}>
        {customBgPath ? <Text style={styles.path} numberOfLines={2}>当前: {customBgPath}</Text> : null}
        <View style={styles.btns}>
          <Button onPress={handleSelectPath}>{'选择图片'}</Button>
          <Button onPress={handleClearPath}>{'清除背景'}</Button>
        </View>
      </SubTitle>
    </>
  )
})

const styles = createStyle({
  path: {
    marginBottom: 10,
  },
  btns: {
    flexDirection: 'row',
  },
})
