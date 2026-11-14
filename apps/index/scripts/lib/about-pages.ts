// Checks the About files against the apps the About pages describe: a page's file is named after an app, and the
// overview's rows hold one line for each app. The content build calls these for every About file, so a page named
// after no app or a missing row fails the build.

import { aboutApps } from '../../src/content/about-apps';

const slugs = new Set(aboutApps.map((app) => app.slug));

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
