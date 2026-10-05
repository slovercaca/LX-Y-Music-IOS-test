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

export const getFolderName = (folder?: LX.WebDAV.DriveFolder | null): string =>
  folder?.path || 'WebDAV 根目录'
