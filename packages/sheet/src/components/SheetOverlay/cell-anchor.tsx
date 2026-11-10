// The box a cell's popover card hangs from, such as the link card or the validation card, laid over the cell's whole
// rectangle inside the overlay region that scrolls with it. Radix hides a card once the cell area clips its anchor
// on any side, and a box with no width at the area's left edge already counts as clipped, so it spans the cell.

import { PopoverAnchor } from '@workspace/ui/components/popover';
import type { CellRect } from '../../state';

export function CellAnchor({ left, top, right, bottom }: CellRect) {
    return (
        <PopoverAnchor asChild>
            <div className="absolute" style={{ left, top, width: right - left, height: bottom - top }} />
        </PopoverAnchor>
    );
}
