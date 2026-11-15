// The Chat page's opening loop: in the crew's production channel the production lead starts a slash command, the
// emote list narrows as she types, and she cheers the tech lead's confirmed generator runs. She deletes the cheer
// again, so the loop ends where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';

// The empty end of the room's title bar, where the resting pointer lights up no message.
const REST = { x: 875, y: 72 };

export const chatHero = {
    name: 'chat-hero',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['chat'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await page.goto(stack.appUrl('chat'));
        await page.getByText('Open site plan').waitFor();
        await Bun.sleep(1500);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await pointOn(page.getByPlaceholder('Message production')));
        await Bun.sleep(500);
        await typeLikeAPerson(page, '/');
        await Bun.sleep(1600);
        await typeLikeAPerson(page, 'ch');
        await Bun.sleep(1200);
        await typeLikeAPerson(page, 'eer');
        await Bun.sleep(500);
        await page.keyboard.press('Enter');
        const cheer = page.getByText('You cheer enthusiastically!');
        await cheer.waitFor();
        await Bun.sleep(2200);
        await cursor.moveTo(await pointOn(cheer));
        await Bun.sleep(600);
        // Every message of hers has a hidden action bar, so the bin is found in the cheer's own row.
        const row = page.locator('div.group', { has: cheer });
        await cursor.click(await pointOn(row.getByRole('button', { name: 'Delete' })));
        await Bun.sleep(800);
        await cursor.click(await pointOn(page.getByRole('dialog').getByRole('button', { name: 'Delete' })));
        await cheer.waitFor({ state: 'detached' });
        await Bun.sleep(600);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
