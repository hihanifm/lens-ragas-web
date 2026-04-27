import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  base: (process.env.VITE_BASE_PATH || '/').replace(/\/?$/, '/'),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GITHUB_URL__: JSON.stringify('https://github.com/hihanifm/lens-ragas-web'),
  },
  server: {
    host: true,
    port: 37101,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:37100',
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})
