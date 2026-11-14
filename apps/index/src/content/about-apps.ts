// The apps the About pages describe: every app in the shared registry except Space, the workspace home, in the
// registry's order. An app's slug is its name in lower case and names both its page's file and its URL, such as
// sheets.md and /about/sheets. The content build checks the About files against this list, and the pages list the
// apps in its order.

import { apps } from '@workspace/lib/apps';

export const aboutApps = apps
    .filter((app) => app.name !== 'Space')
    .map((app) => ({ ...app, slug: app.name.toLowerCase() }));

export type AboutApp = (typeof aboutApps)[number];
