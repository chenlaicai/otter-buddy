import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
// #487（F20260827mpss）：MPA 构建入口从单一清单生成。
// 注意：vite.config 内 @contract alias 不可用（alias 定义在本文件中，esbuild 转译时直接相对路径 import）
import { MPA_PAGES } from '../api-contract/web/pages'

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        MPA_PAGES.map(p => [p.entry, resolve(__dirname, `${p.entry}.html`)])
      ),
    },
  },
  resolve: {
    alias: {
      '@contract': resolve(__dirname, '../api-contract'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // F20260918uhuc：验证隔离——支持 VITE_API_TARGET 指向 alpha 实例（3100+ 段），
        // 缺省 3000（主服务）保持既有开发行为
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
}))
