// The overview's picture of the whole suite: the Space app's home as the festival director sees it, every app she
// can open in one grid.

import type { Scene } from '../lib/scene';

export const suite = {
    name: 'suite',
    kind: 'still',
    theme: 'light',
    viewport: { width: 1600, height: 1000 },
    apps: ['space'],
    personas: ['anouk'],
    run: async ({ pages: [page], stack, hold }) => {
        await page.goto(stack.appUrl('space'));
        await page.getByText('Help and support').waitFor();
        await hold(2500);
    },
} satisfies Scene;
