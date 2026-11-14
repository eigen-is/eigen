// A visible mouse for filmed scenes. A headless page draws no pointer, so CURSOR_SCRIPT, added to each persona's
// browser context, draws an arrow that follows the page's own mouse events. cursor(page) moves that mouse the way a
// hand does: real mouse events along an eased path, so hover states show on the way and a click lands where it points.

import type { Page } from 'playwright-core';

export type Point = { x: number; y: number };
type Target = string | Point;

export type Cursor = {
    moveTo(target: Target, opts?: { duration?: number }): Promise<void>;
    click(target: Target): Promise<void>;
};

const ARROW_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
    '<path d="M2 1.5v16.2l4.3-4.1 2.8 6.6 3-1.3-2.8-6.5h5.9z" fill="#111" stroke="#fff" stroke-width="1.5" ' +
    'stroke-linejoin="round"/></svg>';

// The highest z-index there is, so the arrow draws above every dialog, menu and toast.
export const CURSOR_SCRIPT = `addEventListener('DOMContentLoaded', () => {
    const arrow = document.createElement('div');
    arrow.innerHTML = ${JSON.stringify(ARROW_SVG)};
    arrow.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;opacity:0;transform-origin:0 0;transition:scale 80ms';
    document.body.append(arrow);
    addEventListener('mousemove', (e) => {
        arrow.style.opacity = '1';
        arrow.style.translate = e.clientX + 'px ' + e.clientY + 'px';
    }, true);
    addEventListener('mousedown', () => { arrow.style.scale = '0.85'; }, true);
    addEventListener('mouseup', () => { arrow.style.scale = '1'; }, true);
});`;

const STEP_MS = 16;

export function cursor(page: Page): Cursor {
    const size = page.viewportSize();
    let at: Point = size ? { x: size.width / 2, y: size.height / 2 } : { x: 0, y: 0 };

    const pointOf = async (target: Target): Promise<Point> => {
        if (typeof target !== 'string') return target;
        const box = await page.locator(target).first().boundingBox();
        if (!box) throw new Error(`${target} is not on the page`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    const moveTo = async (target: Target, opts?: { duration?: number }): Promise<void> => {
        const from = at;
        const to = await pointOf(target);
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const duration = opts?.duration ?? Math.min(900, 400 + distance * 0.5);
        const steps = Math.max(1, Math.round(duration / STEP_MS));
        const started = performance.now();
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const eased = t * t * (3 - 2 * t);
            await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
            await Bun.sleep(Math.max(0, started + i * STEP_MS - performance.now()));
        }
        at = to;
    };

    const click = async (target: Target): Promise<void> => {
        await moveTo(target);
        await page.mouse.down();
        await Bun.sleep(70);
        await page.mouse.up();
    };

    return { moveTo, click };
}
