// The Drive page's opening loop: the production lead opens the crew's team drive, goes into the site photos, picks
// one and pages through the rest in the preview. She closes it and goes back up to the drive's folders, so the loop
// ends where it began.

import { centerOf } from '../lib/cursor';
import type { Scene } from '../lib/scene';

const REST = { x: 1450, y: 820 };

export const driveHero = {
    name: 'drive-hero',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['drive'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(stack.appUrl('drive'));
        await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
        await page.getByText('images', { exact: true }).first().waitFor();
        await Bun.sleep(2000);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('main').getByText('images', { exact: true })));
        await Bun.sleep(900);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Open' })));
        await page.getByText('camping-field.webp').first().waitFor();
        await Bun.sleep(1200);
        await cursor.click(await centerOf(page.getByText('camping-field.webp').first()));
        await Bun.sleep(1500);
        await page.keyboard.press('Space');
        await Bun.sleep(1800);
        await cursor.click(await centerOf(page.getByTitle('Next (→)')));
        await Bun.sleep(1600);
        await cursor.click(await centerOf(page.getByTitle('Next (→)')));
        await Bun.sleep(1600);
        await page.keyboard.press('Escape');
        await Bun.sleep(800);
        await cursor.click(
            await centerOf(page.getByRole('navigation', { name: 'breadcrumb' }).getByText('festival', { exact: true })),
        );
        await page.getByText('images', { exact: true }).first().waitFor();
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
