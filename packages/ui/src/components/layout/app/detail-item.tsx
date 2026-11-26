// The parts an opened item's body is built from, so a card, a comment and a calendar event read as one design in any
// dialog: on top the item's own block, square as its tile is on its surface, in the paler panel tone of its color;
// under it a muted meta line, such as who created it; then sections under a caption, such as an event's guests or a
// thread's activity. An opened event takes the meta line and sections without the block.

import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

type DetailItemBlockProps = {
    title: string;
    // The color a person picked for the item, such as its calendar's or the card's. Without one the block is muted.
    color?: string | null;
    children?: ReactNode;
};

export function DetailItemBlock({ title, color, children }: DetailItemBlockProps) {
    const surface = color ? colorSurface(color, 'panel') : undefined;
    return (
        <div
            className={cn('eigen-block px-4 py-3', surface?.className ?? 'bg-muted text-foreground')}
            style={surface?.style}
        >
            <h2 className="text-xl leading-snug font-medium break-words">{title}</h2>
            {children && <div className="mt-1 text-sm">{children}</div>}
        </div>
    );
}

export function DetailMeta({ children }: { children: ReactNode }) {
    return <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">{children}</div>;
}

// With no children it is a caption alone, over a list its host draws below, such as a thread's messages. The first
// in its parent has no gap above it, so it lines up with what sits beside it, such as a contact's photo.
export function DetailSection({ label, children }: { label: string; children?: ReactNode }) {
    return (
        <section className="mt-6 first:mt-0 text-sm">
            <h3 className="eigen-section-label mb-2">{label}</h3>
            {children}
        </section>
    );
}
