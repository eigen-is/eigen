import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import { buildSecurityMetaTags, THEME_FLASH_SCRIPT } from './vite.security-headers';

const sharedWebAssetDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps/index/public');
const sharedWebAssets = [
    ['app-icon.svg', 'image/svg+xml'],
    ['favicon.svg', 'image/svg+xml'],
    ['safari-pinned-tab.svg', 'image/svg+xml'],
    ['site.webmanifest', 'application/manifest+json'],
] as const;

function webAppMetadataPlugin(): Plugin {
    return {
        name: 'eigen-web-app-metadata',
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const pathname = request.url?.split('?')[0];
                const asset = sharedWebAssets.find(([fileName]) => pathname === `/${fileName}`);
                if (!asset) return next();

                const [fileName, contentType] = asset;
                response.setHeader('Content-Type', contentType);
                response.end(readFileSync(path.join(sharedWebAssetDirectory, fileName)));
            });
        },
        transformIndexHtml(html) {
            const withoutExistingIcons = html.replace(/\s*<link[^>]+href="[^"]*\/favicon\.(?:svg|ico)"[^>]*>/g, '');
            return withoutExistingIcons.replace(
                '</head>',
                `    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/app-icon.svg">
    <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#111827">
    <link rel="manifest" href="/site.webmanifest">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="Eigen">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">
</head>`,
            );
        },
    };
}

// The security policy (CSP + referrer meta) and the theme-flash script are injected together, in that
// order: the CSP <meta> must precede the inline script so its script-src hash actually governs it.
// buildContentSecurityPolicy owns THEME_FLASH_SCRIPT and its hash, so the two can never drift.
function securityAndThemePlugin(): Plugin {
    let apiHost = '';
    return {
        name: 'eigen-security-and-theme',
        configResolved(config) {
            apiHost = config.env.VITE_API_HOST ?? '';
        },
        transformIndexHtml: {
            order: 'pre',
            handler(html, ctx) {
                const meta = buildSecurityMetaTags({ dev: Boolean(ctx.server), apiHost });
                return html.replace('<head>', `<head>${meta}<script>${THEME_FLASH_SCRIPT}</script>`);
            },
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
    vector: 3014,
};

export function createAppConfig(appName: string, extraConfig?: UserConfig) {
    const port = APP_PORTS[appName] ?? 3000;
    const basePath = appName === 'index' ? '/' : `/${appName}`;

    const baseConfig: UserConfig = {
        base: basePath,
        envDir: './../../',
        plugins: [
            webAppMetadataPlugin(),
            securityAndThemePlugin(),
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
                                name: 'sheet',
                                test: /(?:packages|node_modules[\\/]@workspace)[\\/]sheet[\\/]/,
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
