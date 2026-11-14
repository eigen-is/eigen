// The overview's picture of the whole suite: the Space app's home as the festival director sees it, every app she
// can open in one grid.

import type { Scene } from '../lib/scene';

export const suite = {
    name: 'suite',
    kind: 'still',
    theme: 'light',
    viewport: { width: 1280, height: 640 },
    apps: ['space'],
    personas: ['anouk'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('space'));
        await page.getByText('Help and support').waitFor();
        await Bun.sleep(2500);
        // The wordmark cycles through the apps every two seconds; the still catches it on Space's own name.
        await page.locator('.select-none.text-3xl', { hasText: 'space' }).waitFor();
    },
} satisfies Scene;
