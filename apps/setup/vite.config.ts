import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import path from 'path'

export default defineConfig({
  base: '/setup',
  envDir: './../../',
  plugins: [
    react(),
    tailwindcss(),
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  server: {
    port: 3011,
  },
  build: {
    target: 'es2023',
    outDir: './../../dist/setup',
    emptyOutDir: true,
  },
})
