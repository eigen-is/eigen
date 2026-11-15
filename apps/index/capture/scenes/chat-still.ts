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
        await page.getByText('Open crew roster').waitFor();
        await Bun.sleep(2000);
    },
} satisfies Scene;
