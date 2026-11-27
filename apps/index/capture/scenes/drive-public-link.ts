// The two stills of the public-link help article, both for the press release draft in the team drive, in light: the
// comms lead's Share dialog with General access on "Anyone with the link", and the same draft as a visitor with no
// login sees it. The second scene turns the link on and saves it, then drops the session to open the draft as a stranger.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_DOC } from '../../../../packages/lib/src/types/drive';
import { openFile } from '../lib/open';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

const DRAFT = 'press release draft';
const PUBLIC_LINE = 'Anyone on the internet with the link can view';

const still: Pick<Scene, 'kind' | 'theme' | 'viewport' | 'apps' | 'personas'> = {
    kind: 'still',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['drive', 'docs'],
    personas: ['mees'],
};

// The draft's Share dialog, with General access on Anyone with the link and nothing saved yet.
async function openPublicShare(page: Page, appUrl: string) {
    await page.goto(appUrl);
    await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
    await page.getByText('marketing', { exact: true }).first().dispatchEvent('click');
    await page.getByRole('button', { name: 'Open' }).dispatchEvent('click');
    await page.getByText(DRAFT, { exact: true }).first().dispatchEvent('click');
    await page.getByRole('heading', { name: DRAFT }).waitFor();
    await Bun.sleep(2000);
    await page.getByRole('button', { name: 'Share' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'General access' }).click();
    await page.getByRole('option', { name: 'Anyone with the link', exact: true }).click();
    await dialog.getByText(PUBLIC_LINE).waitFor();
    return dialog;
}

export const drivePublicLinkDialog = {
    ...still,
    name: 'drive-still-public-link',
    run: async ({ pages: [page], stack }) => {
        await openPublicShare(page, stack.appUrl('drive'));
        await Bun.sleep(1500);
    },
} satisfies Scene;

export const drivePublicLinkVisitor = {
    ...still,
    name: 'drive-still-public-visitor',
    run: async ({ pages: [page], stack }) => {
        const dialog = await openPublicShare(page, stack.appUrl('drive'));
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        // The link is the draft's own address in Docs, which a stranger opens without a session.
        await openFile(page, stack, DRIVE_TYPE_DOC, DRAFT);
        await page.getByRole('heading', { name: 'Press release' }).first().waitFor();
        const link = page.url();
        await page.context().clearCookies();
        await page.goto(link);
        await page
            .getByRole('button', { name: 'Log in' })
            .or(page.getByRole('link', { name: 'Log in' }))
            .first()
            .waitFor();
        await Bun.sleep(2500);
    },
} satisfies Scene;
