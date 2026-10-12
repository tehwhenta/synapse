import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
  server: { port: 5173, strictPort: true },
})
