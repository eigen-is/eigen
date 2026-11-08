// The link card over a cell: hovering a cell's link shows it, with buttons to open, copy, edit or remove the link. The
// card sits under the cell inside the grid. Insert link and the card's pencil set ctx.linkCard editing, and the card
// then opens the link dialog in the sheet's dialog slot in its own place. The card hides while the range picker is
// open, so a pick over a linked cell draws none.

import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Copy, Pencil, Unlink } from 'lucide-react';
import type React from 'react';
import { useContext, useEffect } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { LinkCardProps } from '../../state';
import { goToLink, removeHyperlink, replaceHtml } from '../../state';
import { LinkEditDialog } from './LinkEditDialog';

// pointer-events-auto: the overlay pane-region wrapper is pointer-events none.
// eigen-paper-chrome: the card is app chrome inside the light-pinned workbook
// surface — it re-themes with the app.
const modalBase =
    'eigen-paper-chrome absolute overflow-hidden bg-popover z-30 rounded-md border border-border shadow-md px-5 pt-1.5 pb-2.5 pointer-events-auto';

// The card renders inside the grid's React tree, so its events would bubble into the grid's handlers, which start a
// selection or a cell edit. It keeps them.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const STOP_GRID_EVENTS = {
    onKeyDown: stop,
    onMouseDown: stop,
    onMouseMove: stop,
    onMouseUp: stop,
    onDoubleClick: stop,
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: ${linkAddress} is substituted by replaceHtml() at runtime, not JS template syntax
const GO_TO_FRAME = 'Go to ${linkAddress}';

export function LinkEditCard(link: LinkCardProps) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { showDialog, pickerOpen } = useDialog();
    const { r, c, originType: linkType, originAddress: linkAddress, isEditing, position } = link;

    const setMouseEnter = (mouseEnter: boolean) => {
        if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = mouseEnter;
    };

    // The dialog takes over from the card, which goes: the mouse that was over the card has left it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per request to edit; showDialog and setContext are stable
    useEffect(() => {
        if (!isEditing) return;
        showDialog(<LinkEditDialog link={link} />);
        setMouseEnter(false);
        setContext((ctx) => {
            ctx.linkCard = undefined;
        });
    }, [isEditing]);

    if (isEditing || pickerOpen) return null;

    const toolbarButton = (Icon: LucideIcon, label: string, onClick: () => void) => (
        <button type="button" aria-label={label} className="p-1.5 cursor-pointer hover:bg-accent" onClick={onClick}>
            <Icon className="size-4" aria-hidden="true" />
        </button>
    );

    return (
        <div
            {...STOP_GRID_EVENTS}
            onMouseEnter={() => setMouseEnter(true)}
            onMouseLeave={() => setMouseEnter(false)}
            className={cn(modalBase, 'flex flex-row items-center py-0.5 pl-4 pr-2 text-sm')}
            style={{ left: position.cellLeft + 20, top: position.cellBottom }}
        >
            <button
                type="button"
                className="mr-1.5 cursor-pointer whitespace-nowrap hover:text-primary"
                onClick={() => {
                    setContext((draftCtx) => goToLink(draftCtx, r, c, linkType, linkAddress));
                }}
            >
                {linkType === 'webpage' ? 'Open link' : replaceHtml(GO_TO_FRAME, { linkAddress })}
            </button>
            {context.allowEdit && (
                <>
                    <div className="w-px h-4 mx-1.5 bg-border shrink-0" />
                    {linkType === 'webpage' &&
                        toolbarButton(Copy, 'Copy link', () => {
                            navigator.clipboard.writeText(linkAddress);
                            setMouseEnter(false);
                            setContext((draftCtx) => {
                                draftCtx.linkCard = undefined;
                            });
                        })}
                    {toolbarButton(Pencil, 'Edit link', () =>
                        setContext((draftCtx) => {
                            if (draftCtx.linkCard != null && draftCtx.allowEdit) {
                                draftCtx.linkCard.isEditing = true;
                            }
                        }),
                    )}
                    <div className="w-px h-4 mx-1.5 bg-border shrink-0" />
                    {toolbarButton(Unlink, 'Remove link', () =>
                        setContext((draftCtx) => {
                            setMouseEnter(false);
                            removeHyperlink(draftCtx, r, c);
                        }),
                    )}
                </>
            )}
        </div>
    );
}
