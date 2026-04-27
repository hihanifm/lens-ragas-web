import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 37101,
    proxy: {
      '/api': {
        target: 'http://localhost:37100',
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})
