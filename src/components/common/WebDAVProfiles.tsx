import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import Dialog, { type DialogType } from '@/components/common/Dialog'
import Input from '@/components/common/Input'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import { testConnection } from '@/utils/webdav'
import {
  getWebDAVServerProfiles,
  getActiveWebDAVProfileId,
  saveWebDAVServerProfile,
  deleteWebDAVServerProfile,
  applyWebDAVServerProfile,
  findActiveWebDAVProfile,
  isDuplicateProfileName,
  type WebDAVServerProfile,
} from '@/core/webdavMusic/profiles'

interface EditorState {
  id?: string
  name: string
  url: string
  username: string
  password: string
}

const stripProtocol = (url: string) => url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')

/**
 * WebDAV 服务器配置：一键切换 / 保存 / 编辑 / 删除。
 * 放在「配置」页顶部；下面的手工输入区保留（首次使用、临时服务器仍走那里）。
 */
export default memo(() => {
  const theme = useTheme()
  // 订阅这三个键：切换配置后输入框自动刷新，高亮的「当前生效」也跟着变
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const webdavPassword = useSettingValue('sync.webdav.password')

  const [profiles, setProfiles] = useState<WebDAVServerProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const dialogRef = useRef<DialogType>(null)

  const refresh = useCallback(async() => {
    const [list, id] = await Promise.all([getWebDAVServerProfiles(), getActiveWebDAVProfileId()])
    setProfiles(list)
    setActiveId(id)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const activeProfile = findActiveWebDAVProfile(profiles, activeId)

  const openEditor = useCallback((state: EditorState) => {
    setEditor(state)
    // 等 state 落定再打开，避免 Dialog 首帧拿到旧值
    requestAnimationFrame(() => dialogRef.current?.setVisible(true))
  }, [])

  const handleNew = useCallback(() => {
    openEditor({ name: '', url: webdavUrl || '', username: webdavUsername || '', password: webdavPassword || '' })
  }, [openEditor, webdavUrl, webdavUsername, webdavPassword])

  const handleEdit = useCallback((profile: WebDAVServerProfile) => {
    openEditor({ id: profile.id, name: profile.name, url: profile.url, username: profile.username, password: profile.password })
  }, [openEditor])

  const handleSave = useCallback(async() => {
    if (!editor) return
    const name = editor.name.trim()
    const url = editor.url.trim()
    const username = editor.username.trim()
    if (!name) {
      toast('请给配置起个名字，比如「家里 NAS」')
      return
    }
    if (!url) {
      toast('请填写服务器地址')
      return
    }
    if (!username) {
      toast('请填写用户名')
      return
    }
    if (isDuplicateProfileName(profiles, name, editor.id)) {
      toast(`已存在名为「${name}」的配置`)
      return
    }
    const wasActive = !!editor.id && activeProfile?.id === editor.id
    try {
      const saved = await saveWebDAVServerProfile({
        id: editor.id,
        name,
        url,
        username,
        password: editor.password,
      })
      await refresh()
      dialogRef.current?.setVisible(false)
      setEditor(null)
      if (wasActive) {
        // 编辑的是当前生效的配置：把改动（含密码）同步到连接设置并重置 client
        await applyWebDAVServerProfile(saved.id)
        await refresh()
        toast(`已保存并应用到当前连接`)
      } else {
        toast(`已保存「${saved.name}」`)
      }
    } catch (error: any) {
      toast(`保存失败：${error?.message ?? error}`, 'long')
    }
  }, [editor, profiles, activeProfile, refresh])

  const handleSwitch = useCallback(async(profile: WebDAVServerProfile) => {
    if (testingId) return
    if (activeProfile?.id === profile.id) return
    setTestingId(profile.id)
    toast('正在切换并测试连接...')
    try {
      const applied = await applyWebDAVServerProfile(profile.id)
      if (!applied) {
        // 几乎不可能：点切换后、写入前配置被删了（比如另一处同时删）
        await refresh()
        toast('该配置已被删除', 'long')
        return
      }
      await refresh()
      await testConnection()
      toast(`已切换到「${profile.name}」，连接成功`)
    } catch (error: any) {
      // 切换本身已生效（地址账号已写入），只是连不上：明确告诉用户，避免以为没切过去
      toast(`已切换到「${profile.name}」，但连接失败：${error.message}`, 'long')
    } finally {
      setTestingId(null)
    }
  }, [testingId, activeProfile, refresh])

  const handleDelete = useCallback(async(profile: WebDAVServerProfile) => {
    const ok = await confirmDialog({
      title: '删除配置',
      message: `确定删除「${profile.name}」吗？\n只删除这条配置，不会断开当前连接。`,
    })
    if (!ok) return
    try {
      await deleteWebDAVServerProfile(profile.id)
      await refresh()
      toast(`已删除「${profile.name}」`)
    } catch (error: any) {
      toast(`删除失败：${error?.message ?? error}`, 'long')
    }
  }, [refresh])

  const setEditorField = useCallback((key: keyof EditorState) => (text: string) => {
    setEditor(prev => (prev ? { ...prev, [key]: text } : prev))
  }, [])

  return (
    <View>
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <View style={styles.headerRow}>
          <Text style={styles.label}>服务器配置</Text>
          <TouchableOpacity onPress={handleNew} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text size={13} color={theme['c-primary-font']}>＋ 保存当前连接</Text>
          </TouchableOpacity>
        </View>
        <Text size={12} color={theme['c-font-label']} style={styles.tip}>
          把常用的服务器存成配置，点一下就能切换，不用每次重输地址账号密码。
        </Text>

        {profiles.length === 0 ? (
          <Text size={12} color={theme['c-font-label']} style={styles.empty}>
            还没有保存的配置。填好下面的连接信息后，点右上角「保存当前连接」即可存一条。
          </Text>
        ) : profiles.map(profile => {
          const isActive = activeProfile?.id === profile.id
          const isTesting = testingId === profile.id
          return (
            <TouchableOpacity
              key={profile.id}
              activeOpacity={0.7}
              disabled={isActive || isTesting}
              onPress={() => { void handleSwitch(profile) }}
              style={{
                ...styles.item,
                borderBottomColor: theme['c-border-background'],
                backgroundColor: isActive ? theme['c-primary-light-100-alpha-100'] : 'transparent',
              }}
            >
              <View style={styles.itemMain}>
                <View style={styles.itemTitleRow}>
                  <Text numberOfLines={1} style={styles.itemName}>
                    {profile.name}{isActive ? ' ✓' : ''}
                  </Text>
                </View>
                <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                  {profile.username}@{stripProtocol(profile.url)}
                </Text>
              </View>
              <View style={styles.itemActions}>
                {isTesting ? (
                  <Text size={12} color={theme['c-font-label']}>切换中…</Text>
                ) : (
                  <>
                    {/* 任意一行正在切换测试时，禁用所有行的编辑/删除：
                        避免"删掉正在切换的那条"这种竞态 */}
                    <TouchableOpacity
                      onPress={() => handleEdit(profile)}
                      disabled={testingId !== null}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.actionBtn}
                    >
                      <Text size={12} color={theme['c-primary-font']}>编辑</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { void handleDelete(profile) }}
                      disabled={testingId !== null}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.actionBtn}
                    >
                      <Text size={12} color="#ff3b30">删除</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </TouchableOpacity>
          )
        })}
      </View>

      <Dialog
        ref={dialogRef}
        title={editor?.id ? '编辑服务器配置' : '保存服务器配置'}
        onHide={() => setEditor(null)}
      >
        {/* 注意：这里不能用 InputItem——它是"失焦才 onChanged"的半受控输入，
            点「保存」时若输入框还聚焦着，会读到旧值。改用完全受控的 Input，
            每敲一个字都进 editor state，保存永远拿到最新值。 */}
        <View style={styles.dialogBody}>
          {([
            { key: 'name', label: '名称', placeholder: '比如：家里 NAS' },
            { key: 'url', label: '服务器地址', placeholder: 'https://example.com/webdav', noCapitalize: true },
            { key: 'username', label: '用户名', placeholder: '请输入用户名', noCapitalize: true },
            { key: 'password', label: '密码', placeholder: '请输入密码', secure: true },
          ] as const).map(field => (
            <View
              key={field.key}
              style={{
                ...styles.fieldCard,
                borderColor: theme['c-border-background'],
                backgroundColor: theme['c-primary-light-900-alpha-200'],
              }}
            >
              <Text size={14} style={styles.fieldLabel}>{field.label}</Text>
              <Input
                value={editor?.[field.key] ?? ''}
                onChangeText={setEditorField(field.key)}
                placeholder={field.placeholder}
                secureTextEntry={'secure' in field && field.secure}
                autoCapitalize={'noCapitalize' in field ? 'none' : undefined}
                autoCorrect={false}
                style={{ ...styles.fieldInput, backgroundColor: theme['c-primary-input-background'] }}
              />
            </View>
          ))}
          <View style={styles.dialogBtnRow}>
            <Button
              style={{ ...styles.dialogBtn, backgroundColor: theme['c-button-background'] }}
              onPress={() => dialogRef.current?.setVisible(false)}
            >
              <Text color={theme['c-button-font']}>取消</Text>
            </Button>
            <Button
              style={{ ...styles.dialogBtn, backgroundColor: theme['c-primary-font'] }}
              onPress={() => { void handleSave() }}
            >
              <Text color={theme['c-content-background']}>保存</Text>
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  )
})

const styles = createStyle({
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  label: {
    marginBottom: 6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  tip: {
    marginBottom: 8,
  },
  empty: {
    marginTop: 4,
    lineHeight: 18,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
  },
  itemMain: {
    flex: 1,
    marginRight: 8,
  },
  itemTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  itemName: {
    fontWeight: '600',
    flexShrink: 1,
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dialogBody: {
    padding: 12,
  },
  fieldCard: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 10,
    marginBottom: 8,
  },
  fieldLabel: {
    marginBottom: 6,
  },
  fieldInput: {
    height: 36,
    paddingLeft: 10,
    borderRadius: 6,
  },
  dialogBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    gap: 10,
  },
  dialogBtn: {
    paddingHorizontal: 22,
    paddingVertical: 9,
    borderRadius: 6,
  },
})
