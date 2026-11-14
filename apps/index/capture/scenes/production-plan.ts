// The seeded production plan as the Docs scenes film it: opened ready to film, and the screen point just past the end
// of one of its paragraphs, where a click puts the caret to type on.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_DOC } from '../../../../packages/lib/src/types/drive';
import { DOCS } from '../../../api/src/scripts/demo/content';
import type { Point } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

const [PRODUCTION_PLAN] = DOCS;

export async function openProductionPlan(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_TYPE_DOC, PRODUCTION_PLAN.name);
    await page.getByText('Site & access').waitFor();
    // The camping field's photo and the comment highlights land after the text.
    await Bun.sleep(2500);
}

// The end of the paragraph in the document that holds the text: the right edge of the last line box of its contents.
export async function endOfParagraph(page: Page, text: string): Promise<Point> {
    const boxes = await page
        .locator('.ProseMirror p', { hasText: text })
        .first()
        .evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()].map(({ right, top, height }) => ({ right, top, height }));
        });
    const last = boxes.at(-1);
    if (!last) throw new Error(`"${text}" is not on the page`);
    return { x: last.right + 2, y: last.top + last.height / 2 };
}
