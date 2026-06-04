export type Rect = { x: number; y: number; w: number; h: number };

const MIN_SIZE = 30;

// Resize an axis-aligned rect by dragging one handle. The opposite corner/edge
// stays pinned (unless fromCenter). `mode` is a 'resize-<dir>' string.
export function applyResize(
    mode: string,
    dx: number,
    dy: number,
    { x: ox, y: oy, w: ow, h: oh }: Rect,
    { fromCenter, keepAspect }: { fromCenter: boolean; keepAspect: boolean },
): Rect {
    // Strip the 'resize-' prefix first — 'resize' itself contains 'e' and 's', poisoning the substring check.
    const dir = mode?.split('-')[1] ?? '';
    const xDir = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
    const yDir = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
    // Aspect lock only applies to corners — on edges only one axis is intentional.
    const aspectLocked = keepAspect && xDir !== 0 && yDir !== 0 && ow > 0 && oh > 0;

    let dw = xDir * dx;
    let dh = yDir * dy;

    if (aspectLocked) {
        const aspect = ow / oh;
        if (Math.abs(dw / ow) >= Math.abs(dh / oh)) {
            dh = dw / aspect;
        } else {
            dw = dh * aspect;
        }
    }

    const sizeFactor = fromCenter ? 2 : 1;
    let w = ow + sizeFactor * dw;
    let h = oh + sizeFactor * dh;

    if (aspectLocked) {
        // Clamp both dimensions through a single scale so the ratio survives the MIN_SIZE floor.
        const scale = Math.max(w / ow, MIN_SIZE / ow, MIN_SIZE / oh);
        w = ow * scale;
        h = oh * scale;
    } else {
        w = Math.max(MIN_SIZE, w);
        h = Math.max(MIN_SIZE, h);
    }

    let x: number;
    let y: number;
    if (fromCenter) {
        x = ox + (ow - w) / 2;
        y = oy + (oh - h) / 2;
    } else {
        x = xDir === -1 ? ox + ow - w : ox;
        y = yDir === -1 ? oy + oh - h : oy;
    }

    return { x, y, w, h };
}

// Rotate a vector by `deg` (CSS convention: positive = clockwise, y-down).
export function rotateVec(x: number, y: number, deg: number): { x: number; y: number } {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
}

// Resize a rotated rect: the dragged handle's opposite corner/edge stays fixed in
// world space and the box grows along its own (rotated) axes. Reuses applyResize in
// a center-origin local frame, then repositions the center so the pinned point holds.
// At rotation 0 this returns exactly applyResize(...).
export function resizeRotatedRect(
    mode: string,
    dx: number,
    dy: number,
    start: Rect,
    rotation: number,
    opts: { fromCenter: boolean; keepAspect: boolean },
): Rect {
    if (!rotation) return applyResize(mode, dx, dy, start, opts);
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    const local = rotateVec(dx, dy, -rotation);
    const r = applyResize(mode, local.x, local.y, { x: -start.w / 2, y: -start.h / 2, w: start.w, h: start.h }, opts);
    const dCenter = rotateVec(r.x + r.w / 2, r.y + r.h / 2, rotation);
    return { x: cx + dCenter.x - r.w / 2, y: cy + dCenter.y - r.h / 2, w: r.w, h: r.h };
}

// Snap an angle (degrees) to the nearest `step` (used for Shift->15 degrees rotation).
export function snapAngle(deg: number, step = 15): number {
    return Math.round(deg / step) * step;
}

// Normalize degrees into [0, 360) for storage.
export function normalizeAngle(deg: number): number {
    return ((deg % 360) + 360) % 360;
}
