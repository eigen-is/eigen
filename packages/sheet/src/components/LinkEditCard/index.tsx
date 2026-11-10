// The link card over a cell: hovering a cell's link shows it, with buttons to open, copy, edit or remove the link. A
// popover anchored on the cell holds it under the cell, clear of the selection's fill handle, and flips or shifts it to
// stay inside the grid. Insert link and the card's pencil set ctx.linkCard editing, and the card then opens the link
// dialog in the sheet's dialog slot in its own place. The card hides while the range picker is open or a drag is on,
// and once its cell has lost the link.

import { Popover, PopoverContent } from '@workspace/ui/components/popover';
import type { LucideIcon } from 'lucide-react';
import { Copy, Pencil, Unlink } from 'lucide-react';
import type React from 'react';
import { useContext, useEffect } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { LinkCardProps } from '../../state';
import { getCellHyperlink, goToLink, removeHyperlink } from '../../state';
import { CellAnchor } from '../SheetOverlay/cell-anchor';
import { LinkEditDialog } from './LinkEditDialog';

// The fill handle reaches 5 px past the cell's bottom edge, and the card starts just below it.
const CLEAR_OF_FILL_HANDLE = 6;

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

export function LinkEditCard(link: LinkCardProps) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { showDialog, pickerOpen } = useDialog();
    const { r, c, originType: linkType, originAddress: linkAddress, isEditing, position } = link;

    // The card keeps the events of a drag from reaching the document, so it stays away during one.
    const hidden = isEditing || pickerOpen || context.scrolling || getCellHyperlink(context, r, c) == null;

    // A card that goes from under the pointer fires no mouse leave.
    useEffect(() => {
        if (hidden) return;
        return () => {
            refs.globalCache.linkCard = undefined;
        };
    }, [hidden, refs.globalCache]);

    // The dialog takes over from the card, which goes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per request to edit; showDialog and setContext are stable
    useEffect(() => {
        if (!isEditing) return;
        showDialog(<LinkEditDialog link={link} />);
        setContext((ctx) => {
            ctx.linkCard = undefined;
        });
    }, [isEditing]);

    if (hidden) return null;

    const toolbarButton = (Icon: LucideIcon, label: string, onClick: () => void) => (
        <button type="button" aria-label={label} className="p-1.5 cursor-pointer hover:bg-accent" onClick={onClick}>
            <Icon className="size-4" aria-hidden="true" />
        </button>
    );

    return (
        // Radix places the card again only for a new anchor element, so each cell gets its own.
        <Popover
            key={link.rc}
            open
            onOpenChange={() =>
                setContext((ctx) => {
                    ctx.linkCard = undefined;
                })
            }
        >
            <CellAnchor {...position} />
            <PopoverContent
                {...STOP_GRID_EVENTS}
                onMouseEnter={() => {
                    refs.globalCache.linkCard = { mouseEnter: true };
                }}
                onMouseLeave={() => {
                    refs.globalCache.linkCard = undefined;
                }}
                // Radix's role="dialog" reads as a modal to useDialogOpen, which turns off the find bar's keys.
                role="toolbar"
                side="bottom"
                align="start"
                sideOffset={CLEAR_OF_FILL_HANDLE}
                collisionBoundary={refs.cellArea.current}
                hideWhenDetached
                className="flex w-auto flex-row items-center overflow-hidden py-0.5 pl-4 pr-2 text-sm"
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                // The grid's own hover and press handling decides when the card goes.
                onInteractOutside={(event) => event.preventDefault()}
                // Radix hears Escape on the document's capture phase, so the key closes the card and stops there.
                onEscapeKeyDown={(event) => event.stopPropagation()}
            >
                <button
                    type="button"
                    className="mr-1.5 cursor-pointer whitespace-nowrap hover:text-primary"
                    onClick={() => {
                        setContext((draftCtx) => goToLink(draftCtx, r, c));
                    }}
                >
                    {linkType === 'webpage' ? 'Open link' : `Go to ${linkAddress}`}
                </button>
                {context.allowEdit && (
                    <>
                        <div className="w-px h-4 mx-1.5 bg-border shrink-0" />
                        {linkType === 'webpage' &&
                            toolbarButton(Copy, 'Copy link', () => {
                                navigator.clipboard.writeText(linkAddress);
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
                                removeHyperlink(draftCtx, r, c);
                            }),
                        )}
                    </>
                )}
            </PopoverContent>
        </Popover>
    );
}
