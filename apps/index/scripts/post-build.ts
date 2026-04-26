import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '@workspace/lib/html';

type BlogPostMeta = {
    title: string;
    summary: string;
    date: string;
};

const DEFAULT_DESCRIPTION =
    'Eigen is your minimal, secure workspace in the cloud. Simple and secure. You control your data.';
const BASE_URL = 'https://eigen.is';

// Replace OG/meta tag values in the base HTML template for a specific route.
// The template is the Vite-generated index.html with hashed asset paths.
function withPageMeta(html: string, title: string, description: string, url: string, type: string): string {
    const t = escapeHtml(title);
    const d = escapeHtml(description);
    const u = escapeHtml(url);
    return html
        .replace('<title>eigen</title>', `<title>${t}</title>`)
        .replace('property="og:title" content="eigen"', `property="og:title" content="${t}"`)
        .replaceAll(`content="${DEFAULT_DESCRIPTION}"`, `content="${d}"`)
        .replace('content="website"', `content="${type}"`)
        .replace(`content="${BASE_URL}"`, `content="${u}"`);
}

function postBuild() {
    const distDir = join(process.cwd(), '../../dist/index');
    const baseHtml = readFileSync(join(distDir, 'index.html'), 'utf-8');
    const blogMeta: Record<string, BlogPostMeta> = JSON.parse(
        readFileSync(join(process.cwd(), 'public', 'blog-meta.json'), 'utf-8'),
    );

    const blogDir = join(distDir, 'blog');
    mkdirSync(blogDir, { recursive: true });

    writeFileSync(
        join(blogDir, 'index.html'),
        withPageMeta(
            baseHtml,
            'Blog - eigen',
            'Read about the development of eigen, a minimal and secure workspace in the cloud where you control your own data.',
            `${BASE_URL}/blog`,
            'website',
        ),
    );
    console.log('Generated blog/index.html');

    for (const [id, post] of Object.entries(blogMeta)) {
        const postDir = join(blogDir, id);
        mkdirSync(postDir, { recursive: true });
        writeFileSync(
            join(postDir, 'index.html'),
            withPageMeta(baseHtml, `${post.title} - eigen blog`, post.summary, `${BASE_URL}/blog/${id}`, 'article'),
        );
        console.log(`Generated blog/${id}/index.html`);
    }

    console.log('Post-build completed successfully!');
}

postBuild();
