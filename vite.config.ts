import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/geobirdr/',
  plugins: [react()],
  server: {
    proxy: {
      '/geobirdr': {
        target: 'https://storage.googleapis.com',
        changeOrigin: true,
      },
    },
  },
})
