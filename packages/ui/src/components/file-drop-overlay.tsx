import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { UploadIcon } from 'lucide-react';

type FileDropOverlayProps = {
    // Fades in the drop treatment; drive the visible state from `useFileDropTarget`'s `isDragging`.
    visible: boolean;
    label: string;
    icon?: LucideIcon;
    // Extra classes on the overlay itself — the canvas passes its paper pin so the primary-coloured
    // treatment reads against the page it covers, not the app theme around it.
    className?: string;
};

// The one OS-file drag-over affordance, everywhere a file can be dropped (drive upload, mail
// attach, doc/slide/sheet/vector image insert). Styled after drive's treatment — the visual
// reference. Pure chrome: `pointer-events-none`, positioned by the nearest positioned ancestor,
// so it never intercepts the drop it advertises.
export function FileDropOverlay({ visible, label, icon: Icon = UploadIcon, className }: FileDropOverlayProps) {
    return (
        <div
            className={cn(
                'pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center transition-opacity z-10',
                visible ? 'opacity-100' : 'opacity-0',
                className,
            )}
        >
            <div className="flex items-center gap-2 text-primary text-sm font-medium">
                <Icon className="h-4 w-4" />
                {label}
            </div>
        </div>
    );
}
