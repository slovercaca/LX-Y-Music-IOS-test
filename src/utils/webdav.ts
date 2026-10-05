/**
 * WebDAV 底层工具（重写版）。
 *
 * 实现已收拢到 core/webdavMusic/client.ts（单例 client）与
 * core/webdavMusic/files.ts（远端文件原语），不再各自维护 client 实例。
 * 这里保留原有导出名与签名，调用方（同步流程、设置页、WebDAV 页面）零改动：
 * - resetClient / testConnection —— 连接管理
 * - uploadFile / downloadFile —— 远端文本文件读写（同步备份格式用）
 * - getStat —— 远端 stat（404 → null）
 * - uploadBinaryFile —— 本地二进制文件上传（2 分钟超时、分阶段回调）
 */
export { resetClient, testConnection } from '@/core/webdavMusic/client'
export { uploadFile, downloadFile, getStat, uploadBinaryFile } from '@/core/webdavMusic/files'
