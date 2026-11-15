import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@locales': path.resolve(__dirname, '../../locales'),
    },
  },
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    fs: { allow: ['../..'] },
    proxy: { '/api': 'http://localhost:8787' },
  },
})
