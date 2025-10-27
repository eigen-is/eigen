import type { UserConfig } from 'vite'

interface AppConfig {
  appName: string
  port: number
  basePath: string
}

const APP_PORTS: Record<string, number> = {
  index: 3000,
  mail: 3001,
  drive: 3002,
  contacts: 3003,
  space: 3004,
  calendar: 3005,
  docs: 3006,
  stickies: 3007,
  admin: 3010,
}

export function createSharedViteConfig(config: AppConfig): UserConfig {
  const isDev = process.env.NODE_ENV !== 'production'
  
  const devProxies = isDev ? undefined : undefined
  
  return {
    base: config.basePath,
    envDir: './../../',
    server: {
      port: config.port,
      proxy: devProxies
    },
    build: {
      outDir: `./../../dist/${config.appName}`,
      emptyOutDir: true,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash][extname]',
        },
      },
      minify: 'esbuild',
      sourcemap: false,
    },
  }
}
