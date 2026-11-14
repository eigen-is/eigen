// Opens a seeded document in its editor, the page a click in Drive leads to, for a scene that starts inside one,
// such as the budget or the site plan. The persona's own session finds the file by name among every drive it can
// see, its own and its teams'.

import type { Page } from 'playwright-core';
import type { DrivePath } from '../../../packages/lib/src/types/drive';
import {
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_MIME_VECTOR,
} from '../../../packages/lib/src/types/drive';
import type { Stack } from './scene';

const EDITORS = {
    [DRIVE_MIME_DOC]: { app: 'docs', route: '/doc' },
    [DRIVE_MIME_SHEETS]: { app: 'sheets', route: '/sheet' },
    [DRIVE_MIME_SLIDES]: { app: 'slides', route: '/slide' },
    [DRIVE_MIME_VECTOR]: { app: 'vector', route: '/vector' },
    [DRIVE_MIME_STICKIES]: { app: 'stickies', route: '/board' },
};

export async function openFile(page: Page, stack: Stack, mimeType: keyof typeof EDITORS, name: string): Promise<void> {
    const { user }: { user: { id: string } } = await (
        await page.request.get(`${stack.apiUrl}/auth/get-session`)
    ).json();
    const res = await page.request.get(`${stack.apiUrl}/drive/${user.id}/mime/${mimeType.replace('/', '-')}?teams=1`);
    const paths: DrivePath[] = await res.json();
    const file = paths.find((path) => path.name === `${name}.${mimeType.split('/')[1]}`);
    if (!file) throw new Error(`No ${mimeType} named ${name}`);
    const { app, route } = EDITORS[mimeType];
    await page.goto(`${stack.appUrl(app)}${route}/${file.ownerId}/${file.mountId}/${file.id}`);
}
