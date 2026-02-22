import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  base: '/', // Serve from root for nginx reverse proxy
  build: {
    outDir: 'dist'
  },
  publicDir: 'public' // Copy .nojekyll and other public files
})
