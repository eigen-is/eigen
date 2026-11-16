// The seeded sponsor deck as the Slides scenes film it: opened ready to film, a slide's place in the deck by its key,
// and the screen point of that slide's thumbnail in the rail.

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

// Counting from 0. A key rather than a number keeps a scene on its slide when one is added before it.
export function slideIndex(key: string): number {
    const index = SPONSOR_DECK.slides.findIndex((slide) => slide.key === key);
    if (index < 0) throw new Error(`The sponsor deck has no slide ${key}`);
    return index;
}

export async function thumbnailPoint(page: Page, key: string): Promise<Point> {
    return pointOn(page.locator('[aria-roledescription="sortable"]').nth(slideIndex(key)));
}
