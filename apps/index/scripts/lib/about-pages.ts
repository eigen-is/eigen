// Checks the About files against the apps the About pages describe: a page's file is named after an app, the
// overview's rows hold one line for each app, and each principle an app lists links a help article that exists. The
// content build calls these, so a page named after no app, a missing row or a mistyped article fails the build.

import { aboutApps } from '../../src/content/about-apps';

const slugs = new Set<string>(aboutApps.map((app) => app.slug));

// The slug of an About file, such as `sheets` for sheets.md, or `index` for the overview.
export function aboutPageSlug(file: string): string {
    const slug = file.replace(/\.md$/, '');
    if (slug !== 'index' && !slugs.has(slug)) throw new Error(`About page ${file} is named after no app`);
    return slug;
}

export function checkAboutRows(rows: Record<string, string> | undefined): Record<string, string> {
    const keys = Object.keys(rows ?? {});
    if (!rows || keys.length !== slugs.size || !keys.every((key) => slugs.has(key))) {
        throw new Error(`About overview rows need exactly one line for each of: ${[...slugs].join(', ')}`);
    }
    return rows;
}

export function checkPrincipleArticles(supportSlugs: ReadonlySet<string>): void {
    for (const { article } of aboutApps.flatMap((app) => app.principles)) {
        if (!supportSlugs.has(article)) throw new Error(`About principles link ${article}, which is no help article`);
    }
}
