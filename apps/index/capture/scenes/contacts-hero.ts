// The Contacts page's opening loop: the production lead searches the crew's shared address book, which fills itself
// from the team, and opens a stage hand's card. She clears the search and closes the card, so the loop ends where it
// began.

import { centerOf } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';

// A letter heading in the list, so the resting pointer lights up no row.
const REST = { x: 1100, y: 404 };

export const contactsHero = {
    name: 'contacts-hero',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['contacts'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(stack.appUrl('contacts'));
        await page.getByText('festival crew').first().dispatchEvent('click');
        await page.getByText('Anouk de Wit').waitFor();
        await Bun.sleep(2000);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const search = page.getByPlaceholder('Search contacts...');
        await Bun.sleep(1000);
        await cursor.click(await centerOf(search));
        await Bun.sleep(400);
        await typeLikeAPerson(page, 'sa');
        await Bun.sleep(1500);
        await cursor.click(await centerOf(page.getByText('Sanne Kok')));
        await Bun.sleep(3000);
        await cursor.click(await centerOf(search));
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
        await Bun.sleep(1200);
        await cursor.click(await centerOf(page.getByRole('button', { name: 'Close' })));
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
