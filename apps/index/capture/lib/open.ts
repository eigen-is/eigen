// Opens a seeded document in its editor, the page a click in Drive leads to, for a scene that starts inside one,
// such as the budget or the site plan. The persona's own session finds the file by name among every drive it can
// see, its own and its teams'.

import type { Page } from 'playwright-core';
import type { DrivePath } from '../../../../packages/lib/src/types/drive';
import { EIGEN_DOC_TYPE_INFO, withEigenExtension } from '../../../../packages/lib/src/types/drive';
import type { Stack } from './scene';

// The editor's route under its app, for each type a scene opens.
const EDITOR_ROUTES = { doc: '/doc', sheets: '/sheet', slides: '/slide', vector: '/vector', stickies: '/board' };

export async function openFile(
    page: Page,
    stack: Stack,
    type: keyof typeof EDITOR_ROUTES,
    name: string,
): Promise<void> {
    const { urlSlug, appName } = EIGEN_DOC_TYPE_INFO[type];
    // Lib's typed clients are the browser's, so this script reads the API's JSON as the routes return it.
    const { user }: { user: { id: string } } = await (
        await page.request.get(`${stack.apiUrl}/auth/get-session`)
    ).json();
    const paths: DrivePath[] = await (
        await page.request.get(`${stack.apiUrl}/drive/${user.id}/mime/${urlSlug}?teams=1`)
    ).json();
    const file = paths.find((path) => path.name === withEigenExtension(name, type));
    if (!file) throw new Error(`No ${type} named ${name}`);
    await page.goto(`${stack.appUrl(appName)}${EDITOR_ROUTES[type]}/${file.ownerId}/${file.mountId}/${file.id}`);
}
