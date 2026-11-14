// The Mail page's still: the finance lead's mail from the culture fund, with the invitation to walk the field shown as
// a card under the message.

import type { Scene } from '../lib/scene';

export const mailStillInvite = {
    name: 'mail-still-invite',
    kind: 'still',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['mail'],
    personas: ['bram'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Committee visit to the field').first().dispatchEvent('click');
        await page.getByText('View in Calendar').waitFor();
        await Bun.sleep(2000);
    },
} satisfies Scene;
