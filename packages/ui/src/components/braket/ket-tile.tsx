import type { LucideIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type KetTileProps = {
    icon: LucideIcon;
    title: string;
    description: string;
    // A CSS color, usually `var(--app-<name>-color)`: drives the stripe, icon, title and hover wash.
    color: string;
    className?: string;
    // The link element (`<a>` or a router `<Link>`); the tile's content renders inside it.
    children: ReactNode;
};

// A launcher tile shaped like the wordmark's `|name>`: a 2px stripe on the straight left edge
// is the bar, the logo's ket (4:15, same angle as <Ket />) is the right edge. Hover mirrors
// .eigen-list-item. Shape and sizing live in globals.css under .eigen-ket-tile.
export function KetTile({ icon: Icon, title, description, color, className, children }: KetTileProps) {
    return (
        <Slot.Root
            className={cn('eigen-ket-tile relative block drop-shadow-xs', className)}
            style={{ '--ket-tile-color': color } as CSSProperties}
        >
            <Slot.Slottable>{children}</Slot.Slottable>
            <div className="eigen-ket-tile-body flex h-full items-center gap-3 border-y border-l px-3 md:px-4">
                <Icon className="size-5 shrink-0 md:size-6" style={{ color }} />
                <div className="min-w-0">
                    <h3 className="line-clamp-2 font-medium text-sm leading-tight md:text-base" style={{ color }}>
                        {title}
                    </h3>
                    <p className="hidden text-muted-foreground text-xs md:line-clamp-2">{description}</p>
                </div>
            </div>
            <svg
                className="eigen-ket-tile-ket pointer-events-none absolute right-0 overflow-visible"
                viewBox="0 0 4 15"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path d="M0 0 L4 7.5 L0 15 Z" stroke="none" />
                <path d="M0 0 L4 7.5 L0 15" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
        </Slot.Root>
    );
}
