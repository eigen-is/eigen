// Finds a drawn element on the canvas Slides and Vector share, for a scene that points at one, such as a stage on the
// site plan or a heading in the deck. The demo's builders give every element a fixed id, and the canvas writes it on
// the element's node. A slide's thumbnail in the rail draws the same ids smaller, so the largest match is the canvas.

import type { Page } from 'playwright-core';
import type { Point } from './cursor';
import { pointOn } from './cursor';

export async function elementPoint(page: Page, id: string, across = 0.5, down = 0.5): Promise<Point> {
    const matches = await page.locator(`[data-element-id="${id}"]`).all();
    const areas = await Promise.all(
        matches.map(async (match) => {
            const box = await match.boundingBox();
            return box ? box.width * box.height : 0;
        }),
    );
    const largest = areas.indexOf(Math.max(...areas));
    if (largest < 0) throw new Error(`${id} is not on the page`);
    return pointOn(matches[largest], across, down);
}
