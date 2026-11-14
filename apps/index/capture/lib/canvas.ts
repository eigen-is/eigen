// Finds a drawn element on the canvas Slides and Vector share, for a scene that points at one, such as a stage on the
// site plan or a heading in the deck. The demo's builders give every element a fixed id, and the canvas writes it on
// the element's node. A slide's thumbnail in the rail draws the same ids smaller, so the largest match is the canvas.

import type { Page } from 'playwright-core';
import type { Point } from './cursor';

// A point on the element, as fractions of its box across and down from its top left corner.
export async function elementPoint(page: Page, id: string, across = 0.5, down = 0.5): Promise<Point> {
    const boxes = await Promise.all(
        (await page.locator(`[data-element-id="${id}"]`).all()).map((match) => match.boundingBox()),
    );
    const area = (match: (typeof boxes)[number]) => (match ? match.width * match.height : 0);
    const box = boxes.reduce((largest, match) => (area(match) > area(largest) ? match : largest), null);
    if (!box) throw new Error(`${id} is not on the page`);
    return { x: box.x + across * box.width, y: box.y + down * box.height };
}
