// A comment thread on the production plan: the production lead rests on the highlighted crew shortage, its card shows,
// and a click opens the thread where the volunteer coordinator took it on. She closes the thread and the comments
// panel again, so the loop ends where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openProductionPlan } from './production-plan';

const PASSAGE = 'short on crew for the build weekend';

export const docsComment = {
    name: 'docs-comment',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['docs'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openProductionPlan(page, stack);
        await cursor.moveTo({ x: 770, y: 420 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const passage = await pointOn(page.locator('.ProseMirror [data-comment-id]', { hasText: PASSAGE }), 0.4);
        await Bun.sleep(800);
        await cursor.moveTo(passage);
        await Bun.sleep(1800);
        await cursor.click(passage);
        await Bun.sleep(5000);
        await page.keyboard.press('Escape');
        await Bun.sleep(1000);
        // Opening the thread also opened the comments panel, which the loop's first frame does not have.
        await cursor.click(await pointOn(page.getByRole('button', { name: /^Comments/ })));
        await Bun.sleep(600);
        await cursor.moveTo({ x: 770, y: 420 }, { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
