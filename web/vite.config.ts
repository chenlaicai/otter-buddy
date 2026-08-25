import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        conversation: resolve(__dirname, 'conversation.html'),
        memory: resolve(__dirname, 'memory.html'),
        skills: resolve(__dirname, 'skills.html'),
        settings: resolve(__dirname, 'settings.html'),
        connections: resolve(__dirname, 'connections.html'),
        health: resolve(__dirname, 'health.html'),
      },
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
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
