import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {TanStackRouterVite} from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths'

// https://vitejs.dev/config/
export default defineConfig({
    base: '/docs',
    envDir: './../../',
    server: {
        port: 3006,
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
    },
    build: {
        outDir: './../../dist/docs',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                entryFileNames: 'assets/[name].[hash].js',
                chunkFileNames: 'assets/[name].[hash].js',
                assetFileNames: 'assets/[name].[hash][extname]',
            },
        },
        minify: 'esbuild',
        sourcemap: false, // Disable sourcemaps for minimal size
    }
});
