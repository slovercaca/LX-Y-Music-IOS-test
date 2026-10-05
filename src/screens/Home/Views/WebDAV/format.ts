/**
 * WebDAV 页面共用的格式化工具（从旧 index.tsx 提取，行为不变）。
 */

/** 上传 tab 用：格式化文件大小 */
export const formatUploadSize = (size?: number): string => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export const formatTime = (time?: number): string => {
  if (!time) return ''
  return new Date(time).toLocaleString()
}

export const formatBriefTime = (time?: number): string => {
  if (!time) return ''
  const date = new Date(time)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const formatSize = (size?: number): string => {
  if (!size) return ''
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 上传速度：B/s → 合适单位 */
export const formatSpeed = (bytesPerSec?: number): string => {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

/** 剩余时间：秒 → 人性化 */
export const formatEta = (seconds?: number): string => {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return ''
  if (seconds < 1) return '即将完成'
  if (seconds < 60) return `剩余约 ${Math.ceil(seconds)} 秒`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `剩余约 ${m} 分钟`
  return `剩余约 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
}

export const getFolderName = (folder?: LX.WebDAV.DriveFolder | null): string =>
  folder?.path || 'WebDAV 根目录'
