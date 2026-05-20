import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '@workspace/lib/html';
import { createServer } from 'vite';
import type { ContentManifest } from './lib/content-types';

const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');
const BASE_URL = 'https://eigen.is';
const DEFAULT_DESCRIPTION =
    'Eigen is your minimal, secure workspace in the cloud. Simple and secure. You control your data.';

function manifest(name: string): ContentManifest {
    return JSON.parse(readFileSync(join(GEN, `${name}.manifest.json`), 'utf-8'));
}

type PageMeta = { title: string; description: string; url: string; type: 'website' | 'article'; updated?: string };

// Build the route list: the /blog and /support trees (not "/", which stays SPA).
function routes(): Array<{ path: string; meta: PageMeta }> {
    const list: Array<{ path: string; meta: PageMeta }> = [
        {
            path: '/blog',
            meta: { title: 'Blog - eigen', description: DEFAULT_DESCRIPTION, url: `${BASE_URL}/blog`, type: 'website' },
        },
        {
            path: '/support',
            meta: {
                title: 'Help Center - eigen',
                description: 'Help and documentation for Eigen.',
                url: `${BASE_URL}/support`,
                type: 'website',
            },
        },
    ];
    for (const a of manifest('blog').articles) {
        list.push({
            path: `/blog/${a.slug}`,
            meta: {
                title: `${a.title} - eigen blog`,
                description: a.description,
                url: `${BASE_URL}/blog/${a.slug}`,
                type: 'article',
                updated: a.date,
            },
        });
    }
    const support = manifest('support').articles;
    for (const section of new Set(support.map((a) => a.section))) {
        list.push({
            path: `/support/${section}`,
            meta: {
                title: `${section} - Eigen Help`,
                description: `Help articles for ${section}.`,
                url: `${BASE_URL}/support/${section}`,
                type: 'website',
            },
        });
    }
    for (const a of support) {
        list.push({
            path: `/support/${a.slug}`,
            meta: {
                title: `${a.title} - Eigen Help`,
                description: a.description,
                url: `${BASE_URL}/support/${a.slug}`,
                type: 'article',
                updated: a.updated,
            },
        });
    }
    return list;
}

function withMeta(html: string, m: PageMeta): string {
    const t = escapeHtml(m.title);
    const d = escapeHtml(m.description);
    return html
        .replace('<title>eigen</title>', `<title>${t}</title>`)
        .replace('property="og:title" content="eigen"', `property="og:title" content="${t}"`)
        .replaceAll(`content="${DEFAULT_DESCRIPTION}"`, `content="${d}"`)
        .replace('content="website"', `content="${m.type}"`)
        .replace(`content="${BASE_URL}"`, `content="${escapeHtml(m.url)}"`);
}

// Minimal Article JSON-LD for article pages (SEO). A safe, always-valid schema.
function jsonLd(m: PageMeta): string {
    if (m.type !== 'article') return '';
    const data = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: m.title,
        description: m.description,
        url: m.url,
    };
    // Replace </ to prevent </script> from breaking out of the script tag.
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/<\//g, '<\\/')}</script>`;
}

// dist/index/index.html for "/"; dist/index/<path>/index.html for the rest.
function outFile(path: string): string {
    if (path === '/') return join(DIST, 'index.html');
    const dir = join(DIST, ...path.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    return join(dir, 'index.html');
}

function sitemap(routeList: Array<{ path: string; meta: PageMeta }>): string {
    const urls = routeList
        .map((r) => {
            const loc = escapeHtml(BASE_URL + (r.path === '/' ? '' : r.path));
            const lastmod = r.meta.updated ? `<lastmod>${escapeHtml(r.meta.updated)}</lastmod>` : '';
            return `  <url><loc>${loc}</loc>${lastmod}</url>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// Render through a Vite SSR server so the route tree's Vite-only APIs
// (import.meta.glob in the content loader, import.meta.env app URLs) resolve.
async function main() {
    const vite = await createServer({
        root: ROOT,
        server: { middlewareMode: true },
        appType: 'custom',
        logLevel: 'error',
    });
    try {
        const { render } = (await vite.ssrLoadModule('/src/entry-server.tsx')) as {
            render: (url: string) => Promise<string>;
        };
        const shell = readFileSync(join(DIST, 'index.html'), 'utf-8');
        const all = routes();
        for (const route of all) {
            const appHtml = await render(route.path);
            // React 19 auto-emits <link rel="preload"> for rendered <img> elements.
            // renderToString produces this app fragment with no <head>, so those links
            // land at the top of #app — but in the browser React hoists them to <head>.
            // Move them to <head> here so the prerendered #app matches the client's
            // first render; otherwise hydration mismatches and the page renders twice.
            const hoisted = appHtml.match(/^(?:\s*<link\b[^>]*>)+/)?.[0] ?? '';
            const appBody = appHtml.slice(hoisted.length);
            const page = withMeta(shell, route.meta)
                .replace(
                    '</head>',
                    `${hoisted}<link rel="canonical" href="${escapeHtml(route.meta.url)}"/>${jsonLd(route.meta)}</head>`,
                )
                .replace('<div id="app"></div>', `<div id="app">${appBody}</div>`);
            writeFileSync(outFile(route.path), page);
            console.log(`Prerendered ${route.path}`);
        }
        writeFileSync(join(DIST, 'sitemap.xml'), sitemap(all));
        console.log(`Prerender complete: ${all.length} routes + sitemap.xml`);
    } finally {
        await vite.close();
    }
}

main();
