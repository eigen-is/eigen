// Searching a mailbox: the production lead types into the inbox's search box, the list narrows to the generator
// thread, and she opens its last reply. She clears the search and goes back to the director's all-hands mail, so the
// loop ends where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';

const REST = { x: 1400, y: 760 };

export const mailSearch = {
    name: 'mail-search',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['mail'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Three weeks out').first().dispatchEvent('click');
        await page.getByRole('heading', { name: 'Three weeks out' }).waitFor();
        await Bun.sleep(1500);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const search = page.getByPlaceholder('Search emails...');
        await Bun.sleep(1000);
        await cursor.click(await pointOn(search));
        await Bun.sleep(400);
        await typeLikeAPerson(page, 'generator');
        await Bun.sleep(1500);
        await cursor.click(await pointOn(page.getByText('Re: Generator quote')));
        await Bun.sleep(3000);
        await cursor.click(await pointOn(search));
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
        await Bun.sleep(1200);
        await cursor.click(await pointOn(page.getByText('Three weeks out')));
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
