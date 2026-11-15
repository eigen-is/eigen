// Turns the built single-page shell into a static page for every public route, such as the landing page, the blog
// and each post, the Support pages, the About pages and the changelog. Each page gets its own title, description and
// metadata, and the markup the route renders, which the browser then hydrates in place. It runs after the Vite
// build, and a sitemap comes with it when the server's domain is known.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '@workspace/lib/html';
import { escapeXml } from '@workspace/lib/xml';
import { createServer } from 'vite';
import { withInlineScriptHashes } from '../../../vite.security-headers';
import type { ArticleBody, ContentManifest } from './lib/content-types';

const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');
const DOMAIN = process.env['DOMAIN']?.replace(/\/+$/, '');
const PUBLIC_ORIGIN = DOMAIN ? `https://${DOMAIN}` : undefined;
// The About pages say the same on every server, so each copy names eigen.is's as the one search engines should list.
const ABOUT_ORIGIN = 'https://eigen.is';

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
type ArticleRef = { collection: 'blog' | 'support' | 'about'; slug: string };
type PageArticle = ArticleRef & { body: ArticleBody };
// `canonical` overrides only the page's <link rel="canonical">, not its og:url or its sitemap entry.
type PrerenderRoute = { path: string; meta: PageMeta; article?: ArticleRef; canonical?: string };

function routes(shellDescription: string): PrerenderRoute[] {
    const blogArticles = manifest('blog').articles;
    const support = manifest('support').articles;
    const about = manifest('about').articles;
    const list: PrerenderRoute[] = [
        {
            // The landing page's first render is deterministic, so it hydrates in place: the wordmark starts at the
            // first app, and the buttons and the install line wait for the public config.
            path: '/',
            meta: {
                title: 'eigen - a self-hosted alternative to Google Workspace',
                description: shellDescription,
                url: publicUrl('/'),
                type: 'website',
            },
        },
        {
            path: '/blog',
            meta: { title: 'Blog - eigen', description: shellDescription, url: publicUrl('/blog'), type: 'website' },
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
    for (const post of blogArticles) {
        list.push({
            path: `/blog/${post.slug}`,
            meta: {
                title: `${post.title} - eigen blog`,
                description: post.description,
                url: publicUrl(`/blog/${post.slug}`),
                type: 'article',
                updated: post.date,
            },
            article: { collection: 'blog', slug: post.slug },
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
    for (const article of support) {
        list.push({
            path: `/support/${article.slug}`,
            meta: {
                title: `${article.title} - Eigen Support`,
                description: article.description,
                url: publicUrl(`/support/${article.slug}`),
                type: 'article',
                updated: article.updated,
            },
            article: { collection: 'support', slug: article.slug },
        });
    }
    for (const page of about) {
        const overview = page.slug === 'index';
        const path = overview ? '/about' : `/about/${page.slug}`;
        list.push({
            path,
            meta: {
                title: overview ? page.title : `${page.title} - eigen`,
                description: page.description,
                url: publicUrl(path),
                type: overview ? 'website' : 'article',
            },
            article: { collection: 'about', slug: page.slug },
            canonical: `${ABOUT_ORIGIN}${path}`,
        });
    }
    return list;
}

function withMeta(html: string, meta: PageMeta, shellDescription: string): string {
    const title = escapeHtml(meta.title);
    const description = escapeHtml(meta.description);
    const page = html
        .replace('<title>eigen</title>', `<title>${title}</title>`)
        .replace('property="og:title" content="eigen"', `property="og:title" content="${title}"`)
        .replaceAll(`content="${shellDescription}"`, `content="${description}"`)
        .replace('content="website"', `content="${meta.type}"`);
    const ogUrl = meta.url ? `<meta property="og:url" content="${escapeHtml(meta.url)}"/>` : '';
    // OG scrapers ignore a relative og:image URL, so it gets the origin when that is known.
    const absolutized = PUBLIC_ORIGIN
        ? page.replace('content="/eigen-space-logo.svg', `content="${PUBLIC_ORIGIN}/eigen-space-logo.svg`)
        : page;
    return absolutized.replace('</head>', `${ogUrl}</head>`);
}

function jsonLd(meta: PageMeta): string {
    if (meta.type !== 'article') return '';
    const data = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: meta.title,
        description: meta.description,
        url: meta.url,
    };
    // Replace </ to prevent </script> from breaking out of the script tag.
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/<\//g, '<\\/')}</script>`;
}

function readArticle(ref: ArticleRef): PageArticle {
    const body: ArticleBody = JSON.parse(readFileSync(join(GEN, ref.collection, `${ref.slug}.json`), 'utf-8'));
    return { ...ref, body };
}

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
            const loc = escapeXml(r.meta.url);
            const lastmod = r.meta.updated ? `<lastmod>${escapeXml(r.meta.updated)}</lastmod>` : '';
            return [`  <url><loc>${loc}</loc>${lastmod}</url>`];
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// A Vite SSR server renders the routes, so their Vite-only APIs such as import.meta.glob and import.meta.env resolve.
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
        // index.html holds the site's description, which the home page and the blog index keep and every other page
        // replaces in the meta description and og:description.
        const shellDescription = shell.match(/<meta name="description"\s+content="([^"]*)"/)?.[1];
        if (!shellDescription) throw new Error('index.html has no meta description');
        const all = routes(shellDescription);
        for (const route of all) {
            const article = route.article ? readArticle(route.article) : null;
            const { appHtml, dehydrationHtml } = await render(route.path, article);
            // The browser's React hoists the <link rel="preload"> it emits for an image into <head>, but renderToString
            // leaves it atop #app, so it moves to <head> here or hydration mismatches and the page renders twice.
            const hoisted = appHtml.match(/^(?:\s*<link\b[^>]*>)+/)?.[0] ?? '';
            const appBody = appHtml.slice(hoisted.length);
            // The page's own body is inlined so the first client render has it at once, with </ escaped so the body
            // cannot close the script tag.
            const inlined = article
                ? `<script type="application/json" id="eigen-article-body">${JSON.stringify(article).replace(/<\//g, '<\\/')}</script>`
                : '';
            const canonicalUrl = route.canonical ?? route.meta.url;
            const canonical = canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}"/>` : '';
            const page = withMeta(shell, route.meta, shellDescription)
                .replace('</head>', `${hoisted}${canonical}${jsonLd(route.meta)}</head>`)
                // TanStack's dehydration script is a plain inline script, so it sets window.$_TSR as the HTML parses,
                // before the deferred entry module runs RouterClient's hydrate().
                .replace('<div id="app"></div>', `<div id="app">${appBody}</div>${inlined}${dehydrationHtml}`);
            // The dehydration scripts differ per page, so the CSP meta gets this page's hashes.
            writeFileSync(outFile(route.path), withInlineScriptHashes(page));
            console.log(`Prerendered ${route.path}`);
        }
        if (PUBLIC_ORIGIN) writeFileSync(join(DIST, 'sitemap.xml'), sitemap(all));
        console.log(`Prerender complete: ${all.length} routes${PUBLIC_ORIGIN ? ' + sitemap.xml' : ''}`);
    } finally {
        await vite.close();
    }
}

main();
