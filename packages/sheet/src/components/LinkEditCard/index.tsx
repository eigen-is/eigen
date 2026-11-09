// The link card over a cell: hovering a cell's link shows it, with buttons to open, copy, edit or remove the link. The
// card sits under the cell inside the grid, clear of the selection's fill handle. Insert link and the card's pencil set
// ctx.linkCard editing, and the card then opens the link dialog in the sheet's dialog slot in its own place. The card
// hides while the range picker is open or a drag is on, and once its cell has lost the link.

import type { LucideIcon } from 'lucide-react';
import { Copy, Pencil, Unlink } from 'lucide-react';
import type React from 'react';
import { useContext, useEffect } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { LinkCardProps } from '../../state';
import { getCellHyperlink, goToLink, removeHyperlink } from '../../state';
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
        <div
            {...STOP_GRID_EVENTS}
            onMouseEnter={() => {
                refs.globalCache.linkCard = { mouseEnter: true };
            }}
            onMouseLeave={() => {
                refs.globalCache.linkCard = undefined;
            }}
            // eigen-paper-chrome re-themes the card with the app, inside the light-pinned workbook surface.
            className="eigen-paper-chrome pointer-events-auto absolute z-30 flex flex-row items-center overflow-hidden rounded-md border border-border bg-popover py-0.5 pl-4 pr-2 text-sm shadow-md"
            style={{ left: position.cellLeft + 20, top: position.cellBottom + CLEAR_OF_FILL_HANDLE }}
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
        </div>
    );
}
