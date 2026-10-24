import { storageDataPrefix } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'

// 高：这两个键此前在 storageDataPrefix 里根本不存在（强转读出 undefined），
// EQ/混响自定义预设存不下、重启必丢，且两类预设共用 undefined 键互相覆盖
const soundEffectEQPresetListKey = storageDataPrefix.soundEffectEQPresetList
const soundEffectConvolutionPresetListKey = storageDataPrefix.soundEffectConvolutionPresetList

const createId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const normalizePresetName = (name: string) => name.trim().slice(0, 20)

let userEqPresetList: LX.SoundEffect.EQPreset[] | null = null
let userConvolutionPresetList: LX.SoundEffect.ConvolutionPreset[] | null = null

const getCachedList = async<T>(key: string, cache: T[] | null) => {
  if (cache != null) return cache
  // 2026-10-05 fix（P1-11）：getData 抛错时直接抛出，不回退到 []——
  // 否则 save 路径会把空列表写回，永久清空用户预设
  const data = await getData<T[]>(key)
  return data ?? []
}

const savePresetList = async<T>(key: string, list: T[]) => {
  await saveData(key, list)
  return list
}

export const getUserEQPresetList = async() => {
  // eslint-disable-next-line require-atomic-updates
  userEqPresetList = await getCachedList<LX.SoundEffect.EQPreset>(soundEffectEQPresetListKey, userEqPresetList)
  return [...userEqPresetList]
}

// 低：预设写操作串行化——并发保存时各自读缓存→改→落盘，后落盘者会被
// 旧快照覆盖（H1 修复存取键后才实际显现）。全部写操作排队执行。
let presetOpChain: Promise<unknown> = Promise.resolve()
const runSerial = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = presetOpChain.then(fn, fn)
  presetOpChain = result.catch(() => {})
  return result
}

const saveUserEQPresetImpl = async(preset: Omit<LX.SoundEffect.EQPreset, 'id'>) => {
  // eslint-disable-next-line require-atomic-updates
  userEqPresetList = await getCachedList<LX.SoundEffect.EQPreset>(soundEffectEQPresetListKey, userEqPresetList)
  const nextPreset: LX.SoundEffect.EQPreset = {
    ...preset,
    name: normalizePresetName(preset.name),
    id: createId(),
  }
  userEqPresetList.push(nextPreset)
  await savePresetList(soundEffectEQPresetListKey, userEqPresetList)
  return [...userEqPresetList]
}

const removeUserEQPresetImpl = async(id: string) => {
  // eslint-disable-next-line require-atomic-updates
  userEqPresetList = await getCachedList<LX.SoundEffect.EQPreset>(soundEffectEQPresetListKey, userEqPresetList)
  // eslint-disable-next-line require-atomic-updates
  userEqPresetList = userEqPresetList.filter(item => item.id != id)
  await savePresetList(soundEffectEQPresetListKey, userEqPresetList)
  return [...userEqPresetList]
}

export const getUserConvolutionPresetList = async() => {
  // eslint-disable-next-line require-atomic-updates
  userConvolutionPresetList = await getCachedList<LX.SoundEffect.ConvolutionPreset>(soundEffectConvolutionPresetListKey, userConvolutionPresetList)
  return [...userConvolutionPresetList]
}

const saveUserConvolutionPresetImpl = async(preset: Omit<LX.SoundEffect.ConvolutionPreset, 'id'>) => {
  // eslint-disable-next-line require-atomic-updates
  userConvolutionPresetList = await getCachedList<LX.SoundEffect.ConvolutionPreset>(soundEffectConvolutionPresetListKey, userConvolutionPresetList)
  const nextPreset: LX.SoundEffect.ConvolutionPreset = {
    ...preset,
    name: normalizePresetName(preset.name),
    id: createId(),
  }
  userConvolutionPresetList.push(nextPreset)
  await savePresetList(soundEffectConvolutionPresetListKey, userConvolutionPresetList)
  return [...userConvolutionPresetList]
}

const removeUserConvolutionPresetImpl = async(id: string) => {
  // eslint-disable-next-line require-atomic-updates
  userConvolutionPresetList = await getCachedList<LX.SoundEffect.ConvolutionPreset>(soundEffectConvolutionPresetListKey, userConvolutionPresetList)
  // eslint-disable-next-line require-atomic-updates
  userConvolutionPresetList = userConvolutionPresetList.filter(item => item.id != id)
  await savePresetList(soundEffectConvolutionPresetListKey, userConvolutionPresetList)
  return [...userConvolutionPresetList]
}

export const saveUserEQPreset = (preset: Omit<LX.SoundEffect.EQPreset, 'id'>) => runSerial(() => saveUserEQPresetImpl(preset))
export const removeUserEQPreset = (id: string) => runSerial(() => removeUserEQPresetImpl(id))
export const saveUserConvolutionPreset = (preset: Omit<LX.SoundEffect.ConvolutionPreset, 'id'>) => runSerial(() => saveUserConvolutionPresetImpl(preset))
export const removeUserConvolutionPreset = (id: string) => runSerial(() => removeUserConvolutionPresetImpl(id))
