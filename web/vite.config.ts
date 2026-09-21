import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

/**
 * SPA 单入口构建（F20260920spa）。
 * 不再需要 MPA 多入口——React Router 客户端路由处理页面切换。
 * 路由级代码分割由 React.lazy + import() 在 main.tsx 中完成。
 */
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@contract': resolve(__dirname, '../api-contract'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // F20260920uhuc：验证隔离——支持 VITE_API_TARGET 指向 alpha 实例（3100+ 段），
        // 缺省 3000（主服务）保持既有开发行为
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
}))
