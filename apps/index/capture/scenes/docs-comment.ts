// A comment thread on the production plan: the production lead rests on the highlighted crew shortage, its card shows,
// and a click opens the thread where the volunteer coordinator took it on. She closes the thread and the comments
// panel again, so the loop ends where it began.

import type { Scene } from '../lib/scene';
import { openProductionPlan } from './production-plan';

const PASSAGE = 'short on crew for the build weekend';

export const docsComment = {
    name: 'docs-comment',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['docs'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openProductionPlan(page, stack);
        await cursor.moveTo({ x: 1100, y: 600 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const passage = await page
            .locator('.ProseMirror [data-comment-id]', { hasText: PASSAGE })
            .first()
            .boundingBox();
        if (!passage) throw new Error('The crew shortage is not on the page');
        await Bun.sleep(800);
        await cursor.moveTo({ x: passage.x + passage.width * 0.4, y: passage.y + passage.height / 2 });
        await Bun.sleep(1800);
        await cursor.click({ x: passage.x + passage.width * 0.4, y: passage.y + passage.height / 2 });
        await Bun.sleep(5000);
        await page.keyboard.press('Escape');
        await Bun.sleep(1000);
        // Opening the thread also opened the comments panel, which the loop's first frame does not have.
        const panelButton = await page.getByRole('button', { name: /^Comments/ }).boundingBox();
        if (!panelButton) throw new Error('The Comments button is not on the page');
        await cursor.click({ x: panelButton.x + panelButton.width / 2, y: panelButton.y + panelButton.height / 2 });
        await Bun.sleep(600);
        await cursor.moveTo({ x: 1100, y: 600 }, { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
