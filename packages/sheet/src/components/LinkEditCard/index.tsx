// The link card over a cell: it shows a cell's link and edits or adds one, to a web page, a range or a sheet in the
// workbook. The hover card sits under the cell. The editor is a dialog the grid draws while ctx.linkCard is editing,
// and its OK waits for an address Sheets can open. Picking a range hides the editor while the range picker is open and
// puts the selection back after.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Copy, Grid3x3, Pencil, Unlink } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { LinkCardProps, ViewportPoint } from '../../state';
import {
    computeOverlayRegions,
    goToLink,
    isLinkValid,
    normalizeSelection,
    overlayAnchorToViewport,
    overlayRegionForCell,
    removeHyperlink,
    replaceHtml,
    saveHyperlink,
} from '../../state';
import { CellRangeDialog } from '../CellRangeDialog';

// pointer-events-auto: the overlay pane-region wrapper is pointer-events none.
// eigen-paper-chrome: the card is app chrome inside the light-pinned workbook
// surface — it re-themes with the app.
const modalBase =
    'eigen-paper-chrome absolute overflow-hidden bg-popover z-30 rounded-md border border-border shadow-md px-5 pt-1.5 pb-2.5 pointer-events-auto';

// The range picker keeps the narrow card size and the 5px gap under the cell it had
// when it rendered inside the grid overlay.
const RANGE_PICKER_WIDTH = 380;
const RANGE_PICKER_GAP = 5;

// The events the editor keeps from the grid's handlers around it.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const STOP_GRID_EVENTS = {
    onKeyDown: stop,
    onMouseDown: stop,
    onMouseMove: stop,
    onMouseUp: stop,
    onDoubleClick: stop,
    onContextMenu: stop,
};

// biome-ignore lint/suspicious/noTemplateCurlyInString: ${linkAddress} is substituted by replaceHtml() at runtime, not JS template syntax
const GO_TO_FRAME = 'Go to ${linkAddress}';

const LINK_TYPES = [
    { text: 'Webpages', value: 'webpage' },
    { text: 'Cell range', value: 'cellrange' },
    { text: 'Sheet', value: 'sheet' },
];

export function LinkEditCard({
    r,
    c,
    rc,
    originText,
    originType,
    originAddress,
    isEditing,
    position,
    selectingCellRange,
}: LinkCardProps) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { showNonModalDialog, hideDialog } = useDialog();
    const [linkText, setLinkText] = useState<string>(originText);
    const [linkAddress, setLinkAddress] = useState<string>(originAddress);
    const [linkType, setLinkType] = useState<string>(originType);
    const lastCell = useRef(normalizeSelection(context, [{ row: [r, r], column: [c, c] }]));
    const validity = isLinkValid(linkType, linkAddress);
    const invalidBorder = linkAddress && !validity.isValid && 'border-destructive';

    const tooltip = <div className="h-[17px] my-[3px] text-xs text-destructive">{validity.tooltip}</div>;

    const hideLinkCard = useCallback(() => {
        if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
        setContext((draftCtx) => {
            draftCtx.linkCard = undefined;
        });
    }, [refs.globalCache, setContext]);

    // The picker is a non-modal dialog over the grid, so this editor steps aside while it is open.
    const setRangeModalVisible = useCallback(
        (visible: boolean) =>
            setContext((draftCtx) => {
                draftCtx.selections = lastCell.current;
                if (draftCtx.linkCard != null) draftCtx.linkCard.selectingCellRange = visible;
            }),
        [setContext],
    );

    // position is in sheet-content coordinates: the card used to render inside this cell's
    // OverlayRegion, which applied the pane's scroll transform. The picker is portaled and
    // fixed, so convert here — off the same pane the region would have used.
    const rangePickerAnchor = useCallback((): ViewportPoint | undefined => {
        const area = refs.cellArea.current;
        if (!area) return undefined;
        const { left: areaLeft, top: areaTop } = area.getBoundingClientRect();
        const freeze = refs.globalCache.freezen?.[context.currentSheetId];
        const regions = computeOverlayRegions(freeze, context.cellmainWidth, context.cellmainHeight);
        const { fixedLeft, fixedTop } = overlayRegionForCell(regions, freeze, r, c);
        return overlayAnchorToViewport(
            position.cellLeft,
            position.cellBottom + RANGE_PICKER_GAP,
            areaLeft,
            areaTop,
            fixedLeft,
            fixedTop,
            refs.globalCache.scrollLeft,
            refs.globalCache.scrollTop,
        );
    }, [c, context.cellmainHeight, context.cellmainWidth, context.currentSheetId, position, r, refs]);

    const openRangePicker = useCallback(
        (seed: string) => {
            setRangeModalVisible(true);
            showNonModalDialog(
                <CellRangeDialog
                    value={seed}
                    variant="link"
                    onConfirm={(rangeTxt) => {
                        setLinkAddress(rangeTxt);
                        hideDialog();
                    }}
                    onCancel={hideDialog}
                />,
                {
                    width: RANGE_PICKER_WIDTH,
                    anchor: rangePickerAnchor(),
                    // Every close route, Escape included: leaving the flag set hides the link
                    // card for good — showLinkCard early-returns on it.
                    onClose: () => setRangeModalVisible(false),
                },
            );
        },
        [hideDialog, rangePickerAnchor, setRangeModalVisible, showNonModalDialog],
    );

    const containerEvent = useMemo(
        () => ({
            onMouseEnter: () => {
                if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = true;
            },
            onMouseLeave: () => {
                if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
            },
            onMouseDown: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onMouseMove: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onMouseUp: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => e.stopPropagation(),
            onDoubleClick: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
        }),
        [refs.globalCache],
    );

    const renderToolbarButton = useCallback(
        (Icon: LucideIcon, onClick: () => void) => (
            <button type="button" className="p-1.5 cursor-pointer hover:bg-accent" onClick={onClick}>
                <Icon className="size-4" aria-hidden="true" />
            </button>
        ),
        [],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: `rc` is the trigger — when the active cell changes, reset the form even if the cell's stored link is identical
    useLayoutEffect(() => {
        setLinkAddress(originAddress);
        setLinkText(originText);
        setLinkType(originType);
    }, [rc, originAddress, originText, originType]);

    // Hover preview for an existing link: open / copy / edit / unlink. Anchored to the cell.
    if (!isEditing) {
        return (
            <div
                {...containerEvent}
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
                            renderToolbarButton(Copy, () => {
                                navigator.clipboard.writeText(originAddress);
                                hideLinkCard();
                            })}
                        {renderToolbarButton(Pencil, () =>
                            setContext((draftCtx) => {
                                if (draftCtx.linkCard != null && draftCtx.allowEdit) {
                                    draftCtx.linkCard.isEditing = true;
                                }
                            }),
                        )}
                        <div className="w-px h-4 mx-1.5 bg-border shrink-0" />
                        {renderToolbarButton(Unlink, () =>
                            setContext((draftCtx) => {
                                if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
                                removeHyperlink(draftCtx, r, c);
                            }),
                        )}
                    </>
                )}
            </div>
        );
    }

    // The cell-range picker takes over as a non-modal dialog; this editor reappears on close.
    if (selectingCellRange) return null;

    // The editor renders inside cellArea's React tree, so its events would bubble into the grid's handlers, which
    // start a cell edit, take the focus or undo a sheet edit. The wrapper stops them, as the sheet's modal host does.
    return (
        <div className="contents" {...STOP_GRID_EVENTS}>
            <FormDialog
                open
                onOpenChange={(open) => !open && hideLinkCard()}
                title={originAddress ? 'Edit link' : 'Insert link'}
                size="md"
            >
                <FormDialogForm
                    submitLabel="OK"
                    canSubmit={validity.isValid}
                    onSubmit={() => {
                        if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
                        setContext((draftCtx) => saveHyperlink(draftCtx, r, c, linkText, linkType, linkAddress));
                    }}
                >
                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="link-text">Display text</Label>
                            <Input
                                id="link-text"
                                spellCheck="false"
                                autoFocus
                                value={linkText}
                                onChange={(e) => setLinkText(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="link-type">Link type</Label>
                            <Select
                                value={linkType}
                                onValueChange={(value) => {
                                    if (value === 'sheet') {
                                        if (!linkText) setLinkText(context.sheets[0].name);
                                        setLinkAddress(context.sheets[0].name);
                                    } else {
                                        setLinkAddress('');
                                    }
                                    if (value === 'cellrange') openRangePicker('');
                                    setLinkType(value);
                                }}
                            >
                                <SelectTrigger id="link-type" size="sm" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {LINK_TYPES.map((type) => (
                                        <SelectItem key={type.value} value={type.value}>
                                            {type.text}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {linkType === 'webpage' && (
                            <div className="space-y-1.5">
                                <Label htmlFor="link-address">Link address</Label>
                                <Input
                                    id="link-address"
                                    className={cn(invalidBorder)}
                                    spellCheck="false"
                                    value={linkAddress}
                                    onChange={(e) => setLinkAddress(e.target.value)}
                                />
                                {tooltip}
                            </div>
                        )}
                        {linkType === 'cellrange' && (
                            <div className="space-y-1.5">
                                <Label htmlFor="link-cell">Cell range</Label>
                                <div className="relative">
                                    <Input
                                        id="link-cell"
                                        className={cn('pr-9', invalidBorder)}
                                        spellCheck="false"
                                        value={linkAddress}
                                        onChange={(e) => setLinkAddress(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                                        onClick={() => openRangePicker(linkAddress)}
                                    >
                                        <Grid3x3 className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                                {tooltip}
                            </div>
                        )}
                        {linkType === 'sheet' && (
                            <div className="space-y-1.5">
                                <Label htmlFor="link-sheet">Worksheet</Label>
                                <Select
                                    value={linkAddress}
                                    onValueChange={(value) => {
                                        if (!linkText) setLinkText(value);
                                        setLinkAddress(value);
                                    }}
                                >
                                    <SelectTrigger id="link-sheet" size="sm" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {context.sheets.map((sheet) => (
                                            <SelectItem key={sheet.id} value={sheet.name}>
                                                {sheet.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {tooltip}
                            </div>
                        )}
                    </div>
                </FormDialogForm>
            </FormDialog>
        </div>
    );
}
