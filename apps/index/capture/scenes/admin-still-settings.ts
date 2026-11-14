// The still of the Admin page's server settings: the top of the owner's Settings page, with the organization's name,
// how the server is doing and who Eigen's own mail comes from, in dark.

import { ADMIN_LOCALPART } from '../../../api/src/scripts/demo/content';
import type { Scene } from '../lib/scene';

export const adminStillSettings = {
    name: 'admin-still-settings',
    kind: 'still',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['admin'],
    personas: [ADMIN_LOCALPART],
    run: async ({ pages: [page], stack }) => {
        await page.goto(`${stack.appUrl('admin')}/settings`);
        await page.getByText('Version', { exact: true }).waitFor();
        await page.mouse.move(1599, 899);
        await Bun.sleep(2000);
    },
} satisfies Scene;
