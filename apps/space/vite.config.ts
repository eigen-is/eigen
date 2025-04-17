import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {TanStackRouterVite} from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteTsConfigPaths from 'vite-tsconfig-paths'

// https://vitejs.dev/config/
export default defineConfig({
    base: '/space',
    envDir: './../../',
    server: {
        port: 3004,
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
        outDir: './../../dist/space',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                entryFileNames: 'assets/[name].[hash].js',
                chunkFileNames: 'assets/[name].[hash].js',
                assetFileNames: 'assets/[name].[hash][extname]',
            },
        },
        minify: 'terser', // Use terser for advanced minification
        terserOptions: {
            compress: {
              drop_console: true,
              drop_debugger: true,
              sequences: true,
              properties: true,
              dead_code: true,
              conditionals: true,
              evaluate: true,
              booleans: true,
              loops: true,
              unused: true,
              keep_fargs: false, // remove unused function args
            },
            mangle: {
              toplevel: true,        // mangle top-level names
              properties: true,
            },
            format: {
              comments: false,
              beautify: false,
            },
            module: true,
        },
        sourcemap: false, // Disable sourcemaps for minimal size
    }
});
