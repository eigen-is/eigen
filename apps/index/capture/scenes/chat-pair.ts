// Two people in the production channel at once: the festival director thanks the tech lead for checking the
// generator runs, and the emote arrives live on the programming lead's screen, phrased for him as hers is for her. She
// deletes it, and it goes from his screen too, so the loop ends where it began. The film shows both screens side by
// side. He has never written in the channel, so no notification pops up over it.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';

// The empty end of the room's title bar, where the resting pointer lights up no message.
const REST = { x: 585, y: 71 };

export const chatPair = {
    name: 'chat-pair',
    kind: 'video',
    theme: 'dark',
    // Just wider than a phone, so each window keeps Chat's desktop layout at the narrowest it can.
    viewport: { width: 770, height: 630 },
    composite: 'side-by-side',
    apps: ['chat'],
    personas: ['joris', 'anouk'],
    setup: async ({ pages, cursors, stack }) => {
        await Promise.all(
            pages.map(async (page) => {
                await page.goto(stack.appUrl('chat'));
                await page.getByText('Open site plan').waitFor();
            }),
        );
        await Bun.sleep(1500);
        await Promise.all(cursors.map((cursor) => cursor.moveTo(REST, { duration: 1 })));
    },
    run: async ({ pages: [joris, anouk], cursors: [, anoukCursor] }) => {
        await Bun.sleep(1000);
        await anoukCursor.click(await pointOn(anouk.getByPlaceholder('Message production')));
        await Bun.sleep(500);
        await typeLikeAPerson(anouk, '/thank ti');
        await Bun.sleep(1000);
        await anouk.keyboard.press('Enter');
        await Bun.sleep(500);
        await anouk.keyboard.press('Enter');
        const sent = anouk.getByText(/^You thank /);
        await sent.waitFor();
        await joris.getByText(/thanks Timo Jansen/).waitFor();
        await Bun.sleep(2500);
        await anoukCursor.moveTo(await pointOn(sent));
        await Bun.sleep(600);
        const row = anouk.locator('div.group', { has: sent });
        await anoukCursor.click(await pointOn(row.getByRole('button', { name: 'Delete' })));
        await Bun.sleep(700);
        await anoukCursor.click(await pointOn(anouk.getByRole('dialog').getByRole('button', { name: 'Delete' })));
        await joris.getByText(/thanks Timo Jansen/).waitFor({ state: 'detached' });
        await Bun.sleep(800);
        await anoukCursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
