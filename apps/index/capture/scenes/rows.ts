// The stills of the About overview's app rows, one per app, each on that app's main view as a festival lead finds
// it, such as an open mail thread or the kanban board, and Admin's as the person who runs the server finds it. Themes
// alternate down the list.

import { basename } from 'node:path';
import { DRIVE_TYPE_DOC, DRIVE_TYPE_SLIDES, DRIVE_TYPE_STICKIES } from '../../../../packages/lib/src/types/drive';
import { ADMIN_LOCALPART, DOCS, KANBAN, SPONSOR_DECK } from '../../../api/src/scripts/demo/content';
import { aboutRowStill } from '../../src/content/about-media';
import { openFile } from '../lib/open';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openBudget } from './budget';
import { openFestivalWeek } from './festival-week';
import { openSitePlan, showGround } from './site-plan';

const row = (app: string, theme: Scene['theme'], run: Scene['run']): Scene => ({
    name: basename(aboutRowStill(app), '.webp'),
    kind: 'still',
    theme,
    viewport: VIEWPORT,
    apps: [app],
    personas: ['anouk'],
    run,
});

// Long enough for a page's images and fonts to land once its content shows.
const SETTLE_MS = 2500;

export const ROWS: Scene[] = [
    row('mail', 'light', async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Re: Volunteers needed for build weekend').first().dispatchEvent('click');
        await page.getByText('Hanna').first().waitFor();
        await Bun.sleep(SETTLE_MS);
    }),
    row('drive', 'dark', async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('drive'));
        await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
        await page.getByText('production', { exact: true }).first().dispatchEvent('click');
        await page.getByRole('button', { name: 'Open' }).dispatchEvent('click');
        await page.getByText('site plan', { exact: true }).first().dispatchEvent('click');
        await Bun.sleep(SETTLE_MS);
    }),
    row('calendar', 'light', async ({ pages: [page], stack }) => {
        await openFestivalWeek(page, stack);
        await Bun.sleep(SETTLE_MS);
    }),
    row('docs', 'dark', async ({ pages: [page], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_DOC, DOCS[0].name);
        await page.getByText('Site & access').waitFor();
        await Bun.sleep(SETTLE_MS);
    }),
    row('sheets', 'dark', async ({ pages: [page], stack }) => {
        await openBudget(page, stack);
    }),
    row('slides', 'light', async ({ pages: [page], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_SLIDES, SPONSOR_DECK.name);
        await Bun.sleep(SETTLE_MS * 3);
    }),
    row('vector', 'dark', async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSitePlan(page, stack);
        await showGround(page, cursor);
    }),
    row('stickies', 'light', async ({ pages: [page], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_STICKIES, KANBAN.name);
        await page.getByText(KANBAN.columns[0], { exact: true }).first().waitFor();
        await Bun.sleep(SETTLE_MS);
    }),
    row('chat', 'dark', async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('chat'));
        await page.getByText('Open site plan').waitFor();
        await Bun.sleep(SETTLE_MS);
    }),
    row('contacts', 'light', async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('contacts'));
        await page.getByText('festival crew').first().dispatchEvent('click');
        await page.getByText('Saar Vermeer').first().dispatchEvent('click');
        await Bun.sleep(SETTLE_MS);
    }),
    {
        ...row('admin', 'dark', async ({ pages: [page], stack }) => {
            await page.goto(`${stack.appUrl('admin')}/users`);
            await page.getByText('Saar Vermeer').first().waitFor();
            await Bun.sleep(SETTLE_MS);
        }),
        personas: [ADMIN_LOCALPART],
    },
];
