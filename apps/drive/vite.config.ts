import {defineConfig, mergeConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {TanStackRouterVite} from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths'
import {createSharedViteConfig} from '../../vite.shared.config';

export default defineConfig(mergeConfig(
    createSharedViteConfig({
        appName: 'drive',
        port: 3002,
        basePath: '/drive'
    }),
    {
        plugins: [
            react(),
            TanStackRouterVite({
                target: 'react',
                autoCodeSplitting: false,
            }),
            tailwindcss(),
            viteTsConfigPaths({
                projects: ['./tsconfig.json'],
            }),
        ],
        resolve: {
            extensions: ['.tsx', '.ts', '.jsx', '.js']
        },
    }
));
