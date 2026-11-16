// The still of the Admin page's backups: the owner's Backups section in Settings, with the nightly backup turned on,
// seven kept, and one backup of the whole server made by hand in the list, verified, in light.

import { ADMIN_LOCALPART } from '../../../api/src/scripts/demo/content';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export const adminStillBackups = {
    name: 'admin-still-backups',
    kind: 'still',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['admin'],
    personas: [ADMIN_LOCALPART],
    run: async ({ pages: [page], stack }) => {
        await page.goto(`${stack.appUrl('admin')}/settings`);
        await page.getByRole('button', { name: 'Back up now' }).dispatchEvent('click');
        await page.getByText('Server backed up').waitFor({ timeout: 180_000 });
        await page.getByRole('button', { name: 'Dismiss' }).dispatchEvent('click');
        // The schedule is turned on in the draft and never saved, so no nightly run starts while the stack films.
        const nightly = page.getByText('Back up every night', { exact: true }).locator('xpath=../..');
        await nightly.getByRole('switch').dispatchEvent('click');
        await page
            .getByRole('heading', { name: 'Backups', exact: true })
            .evaluate((heading) => heading.scrollIntoView());
        await Bun.sleep(2000);
    },
} satisfies Scene;
