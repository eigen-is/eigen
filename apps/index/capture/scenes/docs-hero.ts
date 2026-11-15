// The Docs page's opening loop: the production lead adds a line to the production plan's site list, typing it like a
// person, reads it back, and undoes it, so the loop ends where it began.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { endOfParagraph, openProductionPlan } from './production-plan';

export const docsHero = {
    name: 'docs-hero',
    kind: 'video',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['docs'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openProductionPlan(page, stack);
        await cursor.moveTo({ x: 980, y: 315 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        await cursor.click(await endOfParagraph(page, 'Camping field opens Friday midday'));
        await Bun.sleep(600);
        await page.keyboard.press('Enter');
        await typeLikeAPerson(page, 'Water tanks filled on Thursday, before the crew arrives');
        await Bun.sleep(2500);
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        // A click on the grey beside the page leaves the text, so no caret blinks where the loop starts again.
        await cursor.click({ x: 980, y: 315 });
        await Bun.sleep(800);
    },
} satisfies Scene;
