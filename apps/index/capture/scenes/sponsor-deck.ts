// The seeded sponsor deck as the Slides scenes film it: opened ready to film, and the screen point of a slide's
// thumbnail in the rail.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_SLIDES } from '../../../../packages/lib/src/types/drive';
import { SPONSOR_DECK } from '../../../api/src/scripts/demo/content';
import type { Point } from '../lib/cursor';
import { pointOn } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

export async function openSponsorDeck(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_TYPE_SLIDES, SPONSOR_DECK.name);
    await page.locator('[data-element-id="el-title-text-0"]').first().waitFor();
    // The hand-drawn font and the festival mark land after the slide's first paint.
    await Bun.sleep(4000);
}

// The middle of the nth slide's thumbnail, counting from 0.
export async function thumbnailPoint(page: Page, index: number): Promise<Point> {
    return pointOn(page.locator('[aria-roledescription="sortable"]').nth(index));
}
