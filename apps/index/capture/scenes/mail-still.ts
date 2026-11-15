// The Mail page's still: the finance lead's mail from the culture fund, with the invitation to walk the field shown as
// a card under the message.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export const mailStillInvite = {
    name: 'mail-still-invite',
    kind: 'still',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['mail'],
    personas: ['bram'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Committee visit to the field').first().dispatchEvent('click');
        const viewInCalendar = page.getByRole('link', { name: 'View in Calendar' });
        await viewInCalendar.waitFor();
        await Bun.sleep(2000);
        // The card runs past the window's foot, so the message scrolls just far enough to show it whole. The innermost
        // block that holds the button is the card.
        await page
            .locator('div', { has: viewInCalendar })
            .last()
            .evaluate((card) => card.scrollIntoView({ block: 'nearest' }));
        await Bun.sleep(500);
    },
} satisfies Scene;
