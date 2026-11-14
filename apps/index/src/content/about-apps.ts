// The apps the About pages describe: every app in the shared registry except Space, the workspace home, in the
// registry's order. An app's slug is its name in lower case and names both its page's file and its URL, such as
// sheets.md and /about/sheets. The content build checks the About files against this list, and the pages list the
// apps in its order.

import { apps } from '@workspace/lib/apps';

export const aboutApps = apps
    .filter((app) => app.name !== 'Space')
    .map((app) => ({ ...app, slug: app.name.toLowerCase() }));

export type AboutApp = (typeof aboutApps)[number];

const slugs = new Set(aboutApps.map((app) => app.slug));

// The slug of an About file, such as `sheets` for sheets.md, or `index` for the overview.
export function aboutPageSlug(file: string): string {
    const slug = file.replace(/\.md$/, '');
    if (slug !== 'index' && !slugs.has(slug)) throw new Error(`About page ${file} is named after no app`);
    return slug;
}

// The overview's rows, which need a line for every app and for nothing else.
export function checkAboutRows(rows: Record<string, string> | undefined): Record<string, string> {
    const keys = Object.keys(rows ?? {});
    if (!rows || keys.length !== slugs.size || !keys.every((key) => slugs.has(key))) {
        throw new Error(`About overview rows need exactly one line for each of: ${[...slugs].join(', ')}`);
    }
    return rows;
}
