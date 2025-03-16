import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {TanStackRouterVite} from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths'

// https://vitejs.dev/config/
export default defineConfig({
    base: '/contacts',
    server: {
        port: 3003,
    },
    plugins: [
        TanStackRouterVite({
            target: 'react',
            autoCodeSplitting: true,
        }),
        react(),
        tailwindcss(),
        viteTsConfigPaths({
            projects: ['./tsconfig.json'],
        }),
    ],
    resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js']
    }
});
