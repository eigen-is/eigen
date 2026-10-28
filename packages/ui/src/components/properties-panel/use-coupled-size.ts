// The W and H fields of a size panel, coupled while Keep aspect ratio is on: an edit of one side writes the other at
// the box's ratio, in one write, so the host stores both in a single transaction. Size sections such as Slides'
// Transform section and the Docs Size section use it, each over its own units and its own write.

import { useRef } from 'react';
import type { MergedValue } from './merged-value';
import { isMixed } from './merged-value';

// What a size edit writes: a side it leaves out stays as stored.
export type CoupledSize = { width?: number; height?: number };

// Whether the side the host handed back is the one the latch wrote. A host may round a side to show it, so half a px
// either way still counts as the same side.
const isNear = (written: number, side: MergedValue<number>) =>
    !isMixed(side) && side !== undefined && Math.abs(written - side) <= 0.5;

export function useCoupledSize(
    width: MergedValue<number>,
    height: MergedValue<number>,
    locked: boolean,
    onChange: (size: CoupledSize) => void,
): { changeWidth: (width: number) => void; changeHeight: (height: number) => void } {
    // A mixed selection has no single ratio, and with none the sides don't couple.
    const ratio =
        !isMixed(width) && width !== undefined && !isMixed(height) && height !== undefined && height !== 0
            ? width / height
            : null;

    // A host that shows whole px hands back the derived side rounded, so re-deriving the ratio from the box that came
    // back drifts: 100x50 typed up to 250 passes through 25x13 and lands on 250x130 instead of 250x125. The ratio is
    // latched with the box it wrote and reused for as long as the incoming box is still that one, within the half px a
    // rounding moves it. Anything else that moves the box re-derives it.
    const latch = useRef<{ width: number; height: number; ratio: number } | null>(null);
    const held = latch.current;
    const startRatio = held && isNear(held.width, width) && isNear(held.height, height) ? held.ratio : ratio;
    const lockedRatio = locked && startRatio !== null && startRatio > 0 ? startRatio : null;

    // The derived side is exact, as a typed one is, so a locked 4 cm height of a 2:1 box stores 8 cm wide. It is floored
    // at 1, so an extreme ratio never couples a valid edit to a zero size.
    const changeWidth = (w: number) => {
        if (lockedRatio === null) {
            onChange({ width: w });
            return;
        }
        const h = Math.max(1, w / lockedRatio);
        latch.current = { width: w, height: h, ratio: lockedRatio };
        onChange({ width: w, height: h });
    };
    const changeHeight = (h: number) => {
        if (lockedRatio === null) {
            onChange({ height: h });
            return;
        }
        const w = Math.max(1, h * lockedRatio);
        latch.current = { width: w, height: h, ratio: lockedRatio };
        onChange({ width: w, height: h });
    };
    return { changeWidth, changeHeight };
}
