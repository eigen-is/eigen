import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import viteTsConfigPaths from 'vite-tsconfig-paths';

const APP_PORTS: Record<string, number> = {
    index: 3000,
    mail: 3001,
    drive: 3002,
    contacts: 3003,
    space: 3004,
    calendar: 3005,
    docs: 3006,
    stickies: 3007,
    chat: 3008,
    people: 3009,
    admin: 3010,
    setup: 3011,
    slides: 3012,
    sheets: 3013,
};

export function createAppConfig(appName: string, extraConfig?: UserConfig) {
    const port = APP_PORTS[appName] ?? 3000;
    const basePath = appName === 'index' ? '/' : `/${appName}`;

    const baseConfig: UserConfig = {
        base: basePath,
        envDir: './../../',
        plugins: [
            tanstackRouter({
                target: 'react',
                autoCodeSplitting: true,
            }),
            react({
                babel: {
                    plugins: [['babel-plugin-react-compiler']],
                },
            }),
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
            port,
        },
        build: {
            target: 'es2023',
            outDir: `./../../dist/${appName}`,
            emptyOutDir: true,
            commonjsOptions: {
                defaultIsModuleExports: 'auto',
            },
            rollupOptions: {
                treeshake: {
                    preset: 'smallest',
                },
                output: {
                    manualChunks(id) {
                        if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
                            return 'react';
                        }
                        if (id.includes('node_modules/@radix-ui/')) {
                            return 'radix';
                        }
                        if (id.includes('node_modules/@tanstack/')) {
                            return 'tanstack';
                        }
                    },
                },
            },
        },
    };

    return defineConfig(extraConfig ? mergeConfig(baseConfig, extraConfig) : baseConfig);
}
