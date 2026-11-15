// The still of the Chat page: the volunteers channel as the volunteer coordinator reads it, with the crew roster
// attached to a message and the runner's cheers between the lines, in light.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export const chatStillVolunteers = {
    name: 'chat-still-volunteers',
    kind: 'still',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['chat'],
    personas: ['nour'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('chat'));
        await page.getByText('Open site plan').waitFor();
        await page.getByText('volunteers', { exact: true }).first().dispatchEvent('click');
        const roster = page.getByText('Open crew roster');
        await roster.waitFor();
        await Bun.sleep(2000);
        // The channel opens at its last line, with the roster scrolled out above, so it scrolls up to start at the
        // roster's message, as she would. A message's row is the innermost block that lights up under the pointer.
        await page
            .locator('div.group', { has: roster })
            .last()
            .evaluate((row) => row.scrollIntoView({ block: 'start' }));
        await Bun.sleep(500);
    },
} satisfies Scene;
