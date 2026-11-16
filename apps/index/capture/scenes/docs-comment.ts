// A comment thread on the production plan: the production lead rests on the highlighted crew shortage, its card shows,
// and a click opens the thread where the volunteer coordinator took it on. The lead closes the thread and the comments
// panel again, so the loop ends where it began.

import { pointOn } from '../lib/cursor';
import type { Scene, SceneContext } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openProductionPlan } from './production-plan';

const PASSAGE = 'short on crew for the build weekend';
const REST = { x: 770, y: 420 };

export const docsComment = {
    name: 'docs-comment',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['docs'],
    personas: ['saar'],
    setup: async (ctx) => {
        await openProductionPlan(ctx.pages[0], ctx.stack);
        // Opening the thread reads its notification and moves the caret out of the title, so a first visit before the
        // camera rolls lets the loop end on the screen it starts on.
        await openAndCloseThread(ctx);
        await ctx.cursors[0].moveTo(REST, { duration: 1 });
    },
    run: async (ctx) => {
        await Bun.sleep(800);
        await openAndCloseThread(ctx);
        await ctx.cursors[0].moveTo(REST, { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;

async function openAndCloseThread({ pages: [page], cursors: [cursor] }: SceneContext): Promise<void> {
    const passage = await pointOn(page.locator('.ProseMirror [data-comment-id]', { hasText: PASSAGE }), 0.4);
    await cursor.moveTo(passage);
    await Bun.sleep(1800);
    await cursor.click(passage);
    await Bun.sleep(1200);
    // The dialog opens its replies scrolled to the newest, which cuts off the first one's name at this height.
    await cursor.moveTo(await pointOn(page.getByText('On it, sending a fresh call-out')));
    await page.mouse.wheel(0, -200);
    await Bun.sleep(3800);
    await page.keyboard.press('Escape');
    await Bun.sleep(1000);
    // Opening the thread also opened the comments panel, which the loop's first frame does not have.
    await cursor.click(await pointOn(page.getByRole('button', { name: /^Comments/ })));
    await Bun.sleep(600);
}
