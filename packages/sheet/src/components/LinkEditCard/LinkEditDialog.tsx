// The Insert link and Edit link dialog, which the link card opens in the sheet's dialog slot. It edits a cell's link
// to a web page, a range or a sheet in the workbook, and its OK waits for an address Sheets can open. Picking a range
// hands its place to the range picker, which opens this dialog again with the draft, back on the link's cell.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { Grid3x3 } from 'lucide-react';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import type { LinkCardProps, ViewportPoint } from '../../state';
import {
    changeSheet,
    computeOverlayRegions,
    isLinkValid,
    normalizeSelection,
    overlayAnchorToViewport,
    overlayRegionForCell,
    saveHyperlink,
} from '../../state';
import { CellRangeDialog } from '../CellRangeDialog';

// The range picker keeps the narrow card size and the 5px gap under the cell it had when it rendered inside the
// grid overlay.
const RANGE_PICKER_WIDTH = 380;
const RANGE_PICKER_GAP = 5;

const LINK_TYPES = [
    { text: 'Webpages', value: 'webpage' },
    { text: 'Cell range', value: 'cellrange' },
    { text: 'Sheet', value: 'sheet' },
];

// The fields as the user left them when the range picker took this dialog's place.
type LinkDraft = { text: string; type: string; address: string };

export function LinkEditDialog({ link, draft }: { link: LinkCardProps; draft?: LinkDraft }) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { showDialog, showNonModalDialog, hideDialog } = useDialog();
    const [linkText, setLinkText] = useState(draft?.text ?? link.originText);
    const [linkType, setLinkType] = useState(draft?.type ?? link.originType);
    const [linkAddress, setLinkAddress] = useState(draft?.address ?? link.originAddress);
    const { r, c } = link;
    const validity = isLinkValid(linkType, linkAddress);
    const invalidBorder = linkAddress && !validity.isValid && 'border-destructive';

    const tooltip = <div className="h-[17px] my-[3px] text-xs text-destructive">{validity.tooltip}</div>;

    // The position is in sheet-content coordinates, where the cell's overlay region applies the pane's scroll. The
    // picker is portaled and fixed, so it is converted here off the same pane the region would use.
    const rangePickerAnchor = (): ViewportPoint | undefined => {
        const area = refs.cellArea.current;
        if (!area) return undefined;
        const { left: areaLeft, top: areaTop } = area.getBoundingClientRect();
        const freeze = refs.globalCache.freezen?.[context.currentSheetId];
        const regions = computeOverlayRegions(freeze, context.cellmainWidth, context.cellmainHeight);
        const { fixedLeft, fixedTop } = overlayRegionForCell(regions, freeze, r, c);
        return overlayAnchorToViewport(
            link.position.cellLeft,
            link.position.cellBottom + RANGE_PICKER_GAP,
            areaLeft,
            areaTop,
            fixedLeft,
            fixedTop,
            refs.globalCache.scrollLeft,
            refs.globalCache.scrollTop,
        );
    };

    // The picker leaves the grid usable, so rangeDialog.show keeps the cell editor and the link card out of the way.
    // A pick may wander to another sheet, so the picker hands back the link's sheet and cell however it leaves. Its
    // OK opens this dialog again with the picked range, and Cancel or Escape with the draft as it was.
    const pickRange = (before: LinkDraft) => {
        const reopen = (address: string) => showDialog(<LinkEditDialog link={link} draft={{ ...before, address }} />);
        const backToLinkCell = (picking: boolean) =>
            setContext((ctx) => {
                changeSheet(ctx, link.sheetId);
                ctx.selections = normalizeSelection(ctx, [{ row: [r, r], column: [c, c] }]);
                ctx.rangeDialog.show = picking;
            });
        backToLinkCell(true);
        showNonModalDialog(
            <CellRangeDialog value={before.address} variant="link" onConfirm={reopen} onCancel={hideDialog} />,
            {
                width: RANGE_PICKER_WIDTH,
                anchor: rangePickerAnchor(),
                onClose: (reason) => {
                    backToLinkCell(false);
                    if (reason === 'closed') reopen(before.address);
                },
            },
        );
    };

    return (
        <FormDialog {...dialogProps} title={link.originAddress ? 'Edit link' : 'Insert link'} size="md">
            <FormDialogForm
                submitLabel="OK"
                canSubmit={validity.isValid}
                onSubmit={() => setContext((ctx) => saveHyperlink(ctx, r, c, linkText, linkType, linkAddress))}
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
                                if (value === 'cellrange') {
                                    pickRange({ text: linkText, type: value, address: '' });
                                    return;
                                }
                                if (value === 'sheet') {
                                    if (!linkText) setLinkText(context.sheets[0].name);
                                    setLinkAddress(context.sheets[0].name);
                                } else {
                                    setLinkAddress('');
                                }
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
                                    aria-label="Select cell range"
                                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                                    onClick={() => pickRange({ text: linkText, type: linkType, address: linkAddress })}
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
    );
}
