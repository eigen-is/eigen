import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';

// Keep in sync with applyTheme/getCachedTheme in theme-provider.tsx
function themeFlashPlugin(): Plugin {
    return {
        name: 'eigen-theme-flash',
        transformIndexHtml(html) {
            return html.replace(
                '<head>',
                `<head><script>try{var t=localStorage.getItem("eigen-theme");var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch{}</script>`,
            );
        },
    };
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
    chat: 3008,
    admin: 3009,
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
            themeFlashPlugin(),
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
        ],
        resolve: {
            alias: {
                '@': path.resolve(process.cwd(), 'src'),
            },
            tsconfigPaths: true,
        },
        server: {
            port,
        },
        build: {
            target: 'es2023',
            outDir: `./../../dist/${appName}`,
            emptyOutDir: true,
            chunkSizeWarningLimit: 1300,
            rolldownOptions: {
                treeshake: {
                    moduleSideEffects: false,
                    propertyReadSideEffects: false,
                    unknownGlobalSideEffects: false,
                },
                output: {
                    codeSplitting: {
                        groups: [
                            { name: 'react', test: /node_modules[\\/]react(?:-dom)?[\\/]/, priority: 7 },
                            { name: 'radix', test: /node_modules[\\/]@radix-ui[\\/]/, priority: 6 },
                            { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/, priority: 5 },
                            { name: 'numfmt', test: /node_modules[\\/]numfmt[\\/]/, priority: 4 },
                            { name: 'tiptap', test: /node_modules[\\/](?:@tiptap[\\/]|prosemirror-)/, priority: 3 },
                            { name: 'codemirror', test: /node_modules[\\/](?:@codemirror|@lezer)[\\/]/, priority: 2 },
                            {
                                name: 'fortune-sheet',
                                test: /(?:packages|node_modules[\\/]@workspace)[\\/]fortune-sheet[\\/]/,
                                priority: 1,
                            },
                        ],
                    },
                },
            },
        },
    };

    return defineConfig(extraConfig ? mergeConfig(baseConfig, extraConfig) : baseConfig);
}
