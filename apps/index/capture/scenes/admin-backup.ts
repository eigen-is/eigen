// The Admin page's backup loop: the person who runs the server backs up the production lead's account from her
// panel, and the archive lists as verified. He deletes it again and clears the job's line, so the loop ends on the
// empty backup list it began on.

import { ADMIN_LOCALPART, personaByKey } from '../../../api/src/scripts/demo/content';
import { centerOf } from '../lib/cursor';
import type { Scene } from '../lib/scene';

// The sidebar's empty foot, so the resting pointer lights up no row.
const REST = { x: 130, y: 640 };

export const adminBackup = {
    name: 'admin-backup',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['admin'],
    personas: [ADMIN_LOCALPART],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(`${stack.appUrl('admin')}/users`);
        await page.getByText(personaByKey('saar').name).first().dispatchEvent('click');
        await page.getByText('No backups yet.').waitFor();
        // Scrolled as far down as the panel goes, so the warning, the job's line and the archive fit under Backup.
        await page.getByRole('heading', { name: 'Storage' }).evaluate((heading) => heading.scrollIntoView());
        await Bun.sleep(2500);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Create backup' })));
        await page.getByText('Backup created').waitFor({ timeout: 60_000 });
        await page.getByText('Verified').waitFor();
        await Bun.sleep(2500);
        await cursor.moveTo(await centerOf(page.getByText('Verified')), { duration: 700 });
        await Bun.sleep(600);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Delete' }).first()));
        await Bun.sleep(1200);
        await cursor.click(await centerOf(page.getByRole('dialog').getByRole('button', { name: 'Delete' })));
        await page.getByText('No backups yet.').waitFor();
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Dismiss' })));
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
