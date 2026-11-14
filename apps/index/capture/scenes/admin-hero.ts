// The Admin page's opening loop: the person who runs the festival's server opens the production lead's account beside
// the list of users, with her role and the disk she uses, then the crew's team with its drive and its members. Back
// on the users list the loop ends where it began.

import { ADMIN_LOCALPART, personaByKey, TEAM_NAME } from '../../../api/src/scripts/demo/content';
import { centerOf } from '../lib/cursor';
import type { Scene } from '../lib/scene';

// The sidebar's empty foot, so the resting pointer lights up no row.
const REST = { x: 130, y: 640 };

export const adminHero = {
    name: 'admin-hero',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['admin'],
    personas: [ADMIN_LOCALPART],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(`${stack.appUrl('admin')}/users`);
        await page.getByText(personaByKey('saar').name).first().waitFor();
        await Bun.sleep(2500);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('main').getByText(personaByKey('saar').name).first()));
        await page.getByRole('heading', { name: 'Storage' }).waitFor();
        await Bun.sleep(3000);
        await cursor.click(await centerOf(page.getByRole('link', { name: 'Teams' })));
        await page.getByText(TEAM_NAME).first().waitFor();
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('main').getByText(TEAM_NAME).first()));
        await Bun.sleep(3500);
        await cursor.click(await centerOf(page.getByRole('link', { name: 'Users' })));
        await page.getByText(personaByKey('saar').name).first().waitFor();
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
