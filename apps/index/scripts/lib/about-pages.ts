// Checks the About files against the apps the About pages describe: a page's file is named after an app, the
// overview's rows hold one line for each app, and the principle map names only those apps and links help articles
// that exist. The content build calls these, so a page or principle named after no app, a missing row or a mistyped
// article fails the build. It
// also names the blocks a page draws itself, such as the overview's app rows.

import { aboutApps } from '../../src/content/about-apps';

const slugs = new Set(aboutApps.map((app) => app.slug));

// The slug of an About file, such as `sheets` for sheets.md, or `index` for the overview.
export function aboutPageSlug(file: string): string {
    const slug = file.replace(/\.md$/, '');
    if (slug !== 'index' && !slugs.has(slug)) throw new Error(`About page ${file} is named after no app`);
    return slug;
}

// The blocks an About page draws itself where its Markdown puts them: the overview its app rows, an app page none.
export function aboutPageBlocks(slug: string): ReadonlySet<string> {
    return new Set(slug === 'index' ? ['apps'] : []);
}

export function checkAboutRows(rows: Record<string, string> | undefined): Record<string, string> {
    const keys = Object.keys(rows ?? {});
    if (!rows || keys.length !== slugs.size || !keys.every((key) => slugs.has(key))) {
        throw new Error(`About overview rows need exactly one line for each of: ${[...slugs].join(', ')}`);
    }
    return rows;
}

// The apps the principle map holds lines for, such as `sheets`, each of them an About app.
export function checkPrincipleApps(keys: readonly string[]): void {
    for (const key of keys) {
        if (!slugs.has(key)) throw new Error(`About principles name ${key}, which is no About app`);
    }
}

export function checkPrincipleArticles(supportSlugs: ReadonlySet<string>): void {
    for (const { article } of aboutApps.flatMap((app) => app.principles)) {
        if (!supportSlugs.has(article)) throw new Error(`About principles link ${article}, which is no help article`);
    }
}
