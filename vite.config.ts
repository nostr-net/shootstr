import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  base: '/',
  build: {
    outDir: 'dist'
  },
  publicDir: 'public',
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
