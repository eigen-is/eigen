import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '@workspace/lib/html';
import { createServer } from 'vite';
import type { ArticleBody, ContentManifest } from './lib/content-types';

const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');
const DOMAIN = process.env['DOMAIN']?.replace(/\/+$/, '');
const PUBLIC_ORIGIN = DOMAIN ? `https://${DOMAIN}` : undefined;
const DEFAULT_DESCRIPTION =
    'Eigen is your minimal, secure workspace in the cloud. Simple and secure. You control your data.';

function publicUrl(path: string): string | undefined {
    if (!PUBLIC_ORIGIN) return undefined;
    return `${PUBLIC_ORIGIN}${path === '/' ? '' : path}`;
}

function manifest(name: string): ContentManifest {
    return JSON.parse(readFileSync(join(GEN, `${name}.manifest.json`), 'utf-8'));
}

type PageMeta = {
    title: string;
    description: string;
    url: string | undefined;
    type: 'website' | 'article';
    updated?: string;
};
type ArticleRef = { collection: 'blog' | 'support'; slug: string };
type PageArticle = ArticleRef & { body: ArticleBody };
type PrerenderRoute = { path: string; meta: PageMeta; article?: ArticleRef };

// Build the route list: the home page, plus the /blog and /support trees.
function routes(): PrerenderRoute[] {
    const blogArticles = manifest('blog').articles;
    const support = manifest('support').articles;
    const latestBlog = blogArticles[0];
    const list: PrerenderRoute[] = [
        {
            // Landing page. Its first render is deterministic — appIndex starts at 0 and
            // waitlistEnabled is false until the public config resolves — so it hydrates
            // cleanly in place (AuthProvider renders children on the first client render
            // for this ungated app rather than a null loading fallback).
            path: '/',
            meta: { title: 'eigen', description: DEFAULT_DESCRIPTION, url: publicUrl('/'), type: 'website' },
        },
        {
            path: '/blog',
            meta: { title: 'Blog - eigen', description: DEFAULT_DESCRIPTION, url: publicUrl('/blog'), type: 'website' },
            // The blog index renders the latest post in full.
            article: latestBlog ? { collection: 'blog', slug: latestBlog.slug } : undefined,
        },
        {
            path: '/support',
            meta: {
                title: 'Eigen Support',
                description: 'Help and documentation for Eigen.',
                url: publicUrl('/support'),
                type: 'website',
            },
        },
        {
            path: '/licenses',
            meta: {
                title: 'Open-source licenses - eigen',
                description: 'The open-source packages eigen is built on, and their licenses.',
                url: publicUrl('/licenses'),
                type: 'website',
            },
        },
        {
            path: '/changelog',
            meta: {
                title: 'Changelog - eigen',
                description: 'Release notes and user-visible changes to eigen, newest first.',
                url: publicUrl('/changelog'),
                type: 'website',
            },
        },
    ];
    for (const a of blogArticles) {
        list.push({
            path: `/blog/${a.slug}`,
            meta: {
                title: `${a.title} - eigen blog`,
                description: a.description,
                url: publicUrl(`/blog/${a.slug}`),
                type: 'article',
                updated: a.date,
            },
            article: { collection: 'blog', slug: a.slug },
        });
    }
    for (const section of new Set(support.map((a) => a.section))) {
        list.push({
            path: `/support/${section}`,
            meta: {
                title: `${section} - Eigen Support`,
                description: `Help articles for ${section}.`,
                url: publicUrl(`/support/${section}`),
                type: 'website',
            },
        });
    }
    for (const a of support) {
        list.push({
            path: `/support/${a.slug}`,
            meta: {
                title: `${a.title} - Eigen Support`,
                description: a.description,
                url: publicUrl(`/support/${a.slug}`),
                type: 'article',
                updated: a.updated,
            },
            article: { collection: 'support', slug: a.slug },
        });
    }
    return list;
}

function withMeta(html: string, m: PageMeta): string {
    const t = escapeHtml(m.title);
    const d = escapeHtml(m.description);
    const page = html
        .replace('<title>eigen</title>', `<title>${t}</title>`)
        .replace('property="og:title" content="eigen"', `property="og:title" content="${t}"`)
        .replaceAll(`content="${DEFAULT_DESCRIPTION}"`, `content="${d}"`)
        .replace('content="website"', `content="${m.type}"`);
    const ogUrl = m.url ? `<meta property="og:url" content="${escapeHtml(m.url)}"/>` : '';
    // OG scrapers ignore relative og:image URLs — absolutize when the origin is known.
    const absolutized = PUBLIC_ORIGIN
        ? page.replace('content="/eigen-space-logo.svg', `content="${PUBLIC_ORIGIN}/eigen-space-logo.svg`)
        : page;
    return absolutized.replace('</head>', `${ogUrl}</head>`);
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

// Pair a route's article ref with its prerendered body, read from the generated
// content. Used both for the server render and for the inlined hydration <script>.
function readArticle(ref: ArticleRef): PageArticle {
    const body = JSON.parse(readFileSync(join(GEN, ref.collection, `${ref.slug}.json`), 'utf-8')) as ArticleBody;
    return { ...ref, body };
}

// dist/index/index.html for "/"; dist/index/<path>/index.html for the rest.
function outFile(path: string): string {
    if (path === '/') return join(DIST, 'index.html');
    const dir = join(DIST, ...path.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    return join(dir, 'index.html');
}

function sitemap(routeList: PrerenderRoute[]): string {
    const urls = routeList
        .flatMap((r) => {
            if (!r.meta.url) return [];
            const loc = escapeHtml(r.meta.url);
            const lastmod = r.meta.updated ? `<lastmod>${escapeHtml(r.meta.updated)}</lastmod>` : '';
            return [`  <url><loc>${loc}</loc>${lastmod}</url>`];
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
            render: (url: string, article: PageArticle | null) => Promise<{ appHtml: string; dehydrationHtml: string }>;
        };
        const shell = readFileSync(join(DIST, 'index.html'), 'utf-8');
        const all = routes();
        for (const route of all) {
            const article = route.article ? readArticle(route.article) : null;
            const { appHtml, dehydrationHtml } = await render(route.path, article);
            // React 19 auto-emits <link rel="preload"> for rendered <img> elements.
            // renderToString produces this app fragment with no <head>, so those links
            // land at the top of #app — but in the browser React hoists them to <head>.
            // Move them to <head> here so the prerendered #app matches the client's
            // first render; otherwise hydration mismatches and the page renders twice.
            const hoisted = appHtml.match(/^(?:\s*<link\b[^>]*>)+/)?.[0] ?? '';
            const appBody = appHtml.slice(hoisted.length);
            // Inline the page's own body so the client's first render resolves it
            // synchronously — see getInlinedBody in src/content/manifest.ts. Escape
            // </ so the body HTML cannot break out of the script tag.
            const inlined = article
                ? `<script type="application/json" id="eigen-article-body">${JSON.stringify(article).replace(/<\//g, '<\\/')}</script>`
                : '';
            const canonical = route.meta.url ? `<link rel="canonical" href="${escapeHtml(route.meta.url)}"/>` : '';
            const page = withMeta(shell, route.meta)
                .replace('</head>', `${hoisted}${canonical}${jsonLd(route.meta)}</head>`)
                // Append TanStack Router's dehydration <script> (sets window.$_TSR)
                // after the inlined body. It's a plain inline script in the body, so it
                // runs during HTML parse — before the deferred entry module
                // (<script src="/src/main.tsx"> / the hashed bundle in <head>) — so
                // $_TSR exists by the time RouterClient's hydrate() reads it.
                .replace('<div id="app"></div>', `<div id="app">${appBody}</div>${inlined}${dehydrationHtml}`);
            writeFileSync(outFile(route.path), page);
            console.log(`Prerendered ${route.path}`);
        }
        if (PUBLIC_ORIGIN) writeFileSync(join(DIST, 'sitemap.xml'), sitemap(all));
        console.log(`Prerender complete: ${all.length} routes${PUBLIC_ORIGIN ? ' + sitemap.xml' : ''}`);
    } finally {
        await vite.close();
    }
}

main();
