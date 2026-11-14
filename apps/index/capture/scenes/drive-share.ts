// The share dialog on the Drive page: the comms lead opens the press release draft's Share dialog in the team drive
// and adds the local paper's reporter, who asked him for the draft, as a viewer. He cancels before saving, so the loop
// ends where it began and nothing is shared.

import { centerOf } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';

// Empty space under the list, where the resting pointer lights up no row.
const REST = { x: 700, y: 700 };

export const driveShare = {
    name: 'drive-share',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['drive'],
    personas: ['mees'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(stack.appUrl('drive'));
        await page.getByText('festival', { exact: true }).first().dispatchEvent('click');
        await page.getByText('marketing', { exact: true }).first().dispatchEvent('click');
        await page.getByRole('button', { name: 'Open' }).dispatchEvent('click');
        await page.getByText('press release draft', { exact: true }).first().dispatchEvent('click');
        await page.getByRole('heading', { name: 'press release draft' }).waitFor();
        await Bun.sleep(2000);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Share' })));
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await Bun.sleep(1200);
        await cursor.click(await centerOf(dialog.locator('#new-contact')));
        await typeLikeAPerson(page, 'sanne@kustkrant.example');
        await Bun.sleep(600);
        await page.keyboard.press('Enter');
        await Bun.sleep(1500);
        await cursor.click(await centerOf(dialog.getByRole('combobox').last()));
        await Bun.sleep(700);
        await cursor.click(await centerOf(page.getByRole('option', { name: 'Viewer' })));
        await Bun.sleep(2000);
        await cursor.click(await centerOf(dialog.getByRole('button', { name: 'Cancel' })));
        await dialog.waitFor({ state: 'detached' });
        await Bun.sleep(600);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
