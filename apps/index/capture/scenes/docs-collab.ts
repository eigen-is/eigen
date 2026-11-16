// Two people in the production plan at once: the volunteer coordinator answers the plan's crew shortage in its own
// opening line, and her caret and words arrive live on the production lead's screen. She undoes it at the end, so the
// loop ends where it began. The film shows both screens side by side.

import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { endOfParagraph, openProductionPlan } from './production-plan';

const PASSAGE = 'short on crew for the build weekend';
const SAAR_REST = { x: 560, y: 394 };
const NOUR_REST = { x: 700, y: 104 };

export const docsCollabPair = {
    name: 'docs-collab-pair',
    kind: 'video',
    theme: 'light',
    // Just wider than the page, so each window shows it at full size.
    viewport: { width: 800, height: 630 },
    composite: 'side-by-side',
    apps: ['docs'],
    personas: ['saar', 'nour'],
    setup: async ({ pages, cursors: [saarCursor, nourCursor], stack }) => {
        await Promise.all(pages.map((page) => openProductionPlan(page, stack)));
        await saarCursor.moveTo(SAAR_REST, { duration: 1 });
        await nourCursor.moveTo(NOUR_REST, { duration: 1 });
    },
    run: async ({ pages: [saar, nour], cursors: [saarCursor, nourCursor] }) => {
        await Bun.sleep(800);
        await nourCursor.click(await endOfParagraph(nour, PASSAGE));
        await Bun.sleep(900);
        await typeLikeAPerson(nour, ' Fresh call-out goes to the mailing list today.');
        await Bun.sleep(600);
        await saarCursor.moveTo(await endOfParagraph(saar, PASSAGE), { duration: 900 });
        await Bun.sleep(2500);
        await nour.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        // A click on the grey above her page leaves the text, so her caret goes from Saar's screen too.
        await nourCursor.click(NOUR_REST);
        await saarCursor.moveTo(SAAR_REST, { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
