// The still of the Drive page: the production folder selected in the crew's team drive, with its details, who it is
// shared with and the recent activity on everything inside it in the panel beside the list, in light.

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
