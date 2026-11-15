// The still of the Admin page's guests: the office account's list of people from outside, with Hein, the fencing
// supplier, whose guest account came with the site plan Saar shared with him, in dark.

import { ADMIN_LOCALPART, HEIN_KLARENBEEK } from '../../../api/src/scripts/demo/content';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export const adminStillGuests = {
    name: 'admin-still-guests',
    kind: 'still',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['admin'],
    personas: [ADMIN_LOCALPART],
    run: async ({ pages: [page], stack }) => {
        await page.goto(`${stack.appUrl('admin')}/guests`);
        await page.getByRole('main').getByText(HEIN_KLARENBEEK.email).filter({ visible: true }).waitFor();
        await Bun.sleep(2000);
    },
} satisfies Scene;
