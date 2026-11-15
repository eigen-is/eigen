// The stills of the Drive page, each in the crew's team drive: the production folder selected, with who it is shared
// with and the recent activity on everything inside it in the panel beside the list, in light, and the site photos as
// tiles in the grid view, in dark.

import type { Scene } from '../lib/scene';

export const driveStillActivity = {
    name: 'drive-still-activity',
    kind: 'still',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['drive'],
    personas: ['saar'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('drive'));
        await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
        await page.getByText('production', { exact: true }).first().dispatchEvent('click');
        await page.getByText('Recent activity').waitFor();
        // The panel opens on the folder's picture, and the activity sits below the fold until it scrolls up.
        await page.getByRole('heading', { name: 'Shared with' }).evaluate((heading) => heading.scrollIntoView());
        await Bun.sleep(2000);
    },
} satisfies Scene;

// The grid view is saved in Saar's settings, so this scene films after every other scene that shows her drive.
export const driveStillTiles = {
    name: 'drive-still-tiles',
    kind: 'still',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['drive'],
    personas: ['saar'],
    setup: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('drive'));
        await page.getByLabel('Grid view').dispatchEvent('click');
    },
    run: async ({ pages: [page] }) => {
        await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
        await page.getByText('images', { exact: true }).first().dispatchEvent('click');
        await page.getByRole('button', { name: 'Open' }).dispatchEvent('click');
        await page.getByText('camping-field.webp').first().waitFor();
        // The tiles load their thumbnails lazily, so the still waits until every one has drawn.
        await page.waitForFunction(() =>
            [...document.querySelectorAll('[role="grid"] img')].every(
                (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
            ),
        );
        await Bun.sleep(2000);
    },
} satisfies Scene;
