/**
 * WebDAV drive 兼容层。
 *
 * 实现已重写并拆分到四个模块：
 * - ./client.ts —— 单例 client、认证头、直链 URL、远端目录语义
 * - ./files.ts —— 远端文件原语（读写/上传/原子下载）
 * - ./library.ts —— 歌曲库（扫描/配置/封面歌词/播放下载/上传）
 * - ./upload.ts —— 上传传输（XHR 真实进度 + webdav 库兜底 + 大小校验）与队列类型
 *
 * 这里只做同名 re-export：导出名、签名、行为与旧 drive.ts 完全一致，
 * 所有调用方（core/music/local.ts、WebDAV 页面等）零改动。
 * 存储键 '@webdav_music_config'、歌曲 id `webdav_${filename}`、
 * 缓存目录布局均保持不变。
 */
export * from './client'
export * from './files'
export * from './library'
export * from './upload'
