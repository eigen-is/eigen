// The column a page opens at its right to show one thing the user opened, such as a calendar event or a document's
// comments. Its bar names a list, never an item: a list's title, a "‹" back once it drilled into one item, the
// item's actions, and the X that closes it, which a phone swaps for a lone "‹" at the left. Esc closes it too, unless
// a dialog, a menu or a field has the key, or a handler that heard it first used it, such as a canvas canceling a drag.

import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { isTypingTarget } from '../../../hooks/is-typing-target';
import { useDialogOpen, useMenuOpen } from '../../../hooks/use-dialog-open';
import { BackButton } from '../toolbar/back-button';
import { ToolbarTitle } from '../toolbar/toolbar-title';
import { TooltipButton } from '../toolbar/tooltip-button';
import { Column } from './column-layout';
import type { ColumnWidth } from './column-widths';
import { useLayout } from './layout-context';

type DetailColumnProps = {
    width: ColumnWidth;
    // Only over a list, such as the comments list: an item names itself in its body.
    title?: string;
    // Back from an item to the list it was opened from inside the column.
    onBack?: () => void;
    actions?: ReactNode;
    onClose: () => void;
    // The body fills the column and scrolls itself, such as a comment thread over its pinned composer.
    fill?: boolean;
    children: ReactNode;
};

export function DetailColumn({ width, title, onBack, actions, onClose, fill, children }: DetailColumnProps) {
    const { isMobile } = useLayout();
    const dialogOpen = useDialogOpen();
    const menuOpen = useMenuOpen();

    // On the window, so every document listener hears the key first and one that uses it calls preventDefault.
    useEffect(() => {
        if (dialogOpen || menuOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented && !isTypingTarget()) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [dialogOpen, menuOpen, onClose]);

    // Column gets no onBack: its own phone back would be a second "‹" beside this one.
    return (
        <div data-slot="detail-column" className="contents">
            <Column
                id="detail"
                width={width}
                className={cn('bg-background', !isMobile && 'border-l')}
                toolbar={
                    <>
                        {onBack ? (
                            <BackButton onClick={onBack} label={title} />
                        ) : (
                            <>
                                {isMobile && <BackButton onClick={onClose} />}
                                {title && <ToolbarTitle>{title}</ToolbarTitle>}
                            </>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                            {actions}
                            {!isMobile && (
                                <TooltipButton icon={X} tooltipText="Close" className="ml-2" onClick={onClose} />
                            )}
                        </div>
                    </>
                }
            >
                {fill ? children : <div className="h-full overflow-y-auto app-gutter-x pt-4 pb-6">{children}</div>}
            </Column>
        </div>
    );
}
