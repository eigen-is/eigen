// The Insert link and Edit link dialog, which the link card opens in the sheet's dialog slot. It edits a cell's link
// to a web page, a range or a sheet in the workbook, and its Apply refuses an address Sheets can't open, with the
// reason under the field. Picking a range hands its place to the range picker, which opens this dialog again with the
// draft, back on the link's cell.

import type { CellLinkType } from '@workspace/lib/sheets';
import { isCellLinkType } from '@workspace/lib/sheets';
import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@workspace/ui/components/input-group';
import { LinkAddressField, LinkTextField } from '@workspace/ui/components/link-fields';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Grid3x3 } from 'lucide-react';
import { useContext, useId, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import type { LinkCardProps, ViewportPoint } from '../../state';
import {
    changeSheet,
    computeOverlayRegions,
    freezeOf,
    isLinkValid,
    normalizeSelection,
    overlayAnchorToViewport,
    overlayRegionForCell,
    saveHyperlink,
} from '../../state';
import { CellRangeDialog, NO_RANGE_MESSAGE } from '../CellRangeDialog';

// The range picker opens a few pixels under the link's cell.
const RANGE_PICKER_GAP = 5;

const LINK_TYPES: { text: string; value: CellLinkType }[] = [
    { text: 'Webpages', value: 'webpage' },
    { text: 'Cell range', value: 'cellrange' },
    { text: 'Sheet', value: 'sheet' },
];

// The fields as the user left them when the range picker took this dialog's place.
type LinkDraft = { text: string; type: CellLinkType; address: string };

export function LinkEditDialog({ link, draft }: { link: LinkCardProps; draft?: LinkDraft }) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { showDialog, showNonModalDialog } = useDialog();
    const [linkText, setLinkText] = useState(draft?.text ?? link.originText);
    const [linkType, setLinkType] = useState(draft?.type ?? link.originType);
    const [linkAddress, setLinkAddress] = useState(draft?.address ?? link.originAddress);
    const { r, c } = link;
    const validity = isLinkValid(linkType, linkAddress);

    // The position is in sheet-content coordinates, where the cell's overlay region applies the pane's scroll. The
    // picker is portaled and fixed, so it is converted here off the same pane the region would use.
    const rangePickerAnchor = (): ViewportPoint | undefined => {
        const area = refs.cellArea.current;
        if (!area) return undefined;
        const { left: areaLeft, top: areaTop } = area.getBoundingClientRect();
        const freeze = freezeOf(context);
        const regions = computeOverlayRegions(freeze, context.cellmainWidth, context.cellmainHeight);
        const { fixedLeft, fixedTop } = overlayRegionForCell(regions, freeze, r, c);
        return overlayAnchorToViewport(
            link.position.left,
            link.position.bottom + RANGE_PICKER_GAP,
            areaLeft,
            areaTop,
            fixedLeft,
            fixedTop,
            refs.globalCache.scrollLeft,
            refs.globalCache.scrollTop,
        );
    };

    // A pick may wander to another sheet, so coming back also goes back to the link's sheet and cell. The picker's Select
    // comes back with the picked range, and Cancel or Escape with the draft as it was.
    const pickRange = (before: LinkDraft) => {
        const reopen = (address: string) => {
            setContext((ctx) => {
                changeSheet(ctx, link.sheetId);
                ctx.selections = normalizeSelection(ctx, [{ row: [r, r], column: [c, c] }]);
            });
            showDialog(<LinkEditDialog link={link} draft={{ ...before, address }} />);
        };
        const cancel = () => reopen(before.address);
        showNonModalDialog(
            <CellRangeDialog value={before.address} variant="link" onConfirm={reopen} onCancel={cancel} />,
            { anchor: rangePickerAnchor(), onEscape: cancel },
        );
    };

    return (
        <FormDialog {...dialogProps} title={link.originAddress ? 'Edit link' : 'Insert link'}>
            <FormDialogForm
                submitLabel="Apply"
                changed={
                    linkText !== link.originText || linkType !== link.originType || linkAddress !== link.originAddress
                }
                onSubmit={() => {
                    if (!validity.isValid) return false;
                    setContext((ctx) => saveHyperlink(ctx, r, c, linkText, linkType, linkAddress));
                }}
            >
                <LinkTextField value={linkText} onValueChange={setLinkText} autoFocus />
                <Field>
                    <FieldLabel htmlFor="link-type">Link type</FieldLabel>
                    <Select
                        value={linkType}
                        onValueChange={(value) => {
                            if (!isCellLinkType(value)) return;
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
                        <SelectTrigger id="link-type" className="w-full">
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
                </Field>
                {linkType === 'webpage' && <LinkAddressField value={linkAddress} onValueChange={setLinkAddress} />}
                {linkType === 'cellrange' && (
                    <RangeField
                        value={linkAddress}
                        refusal={validity.tooltip}
                        onValueChange={setLinkAddress}
                        onPick={() => pickRange({ text: linkText, type: linkType, address: linkAddress })}
                    />
                )}
                {linkType === 'sheet' && (
                    <Field>
                        <FieldLabel htmlFor="link-sheet">Worksheet</FieldLabel>
                        <Select
                            value={linkAddress}
                            onValueChange={(value) => {
                                if (!linkText) setLinkText(value);
                                setLinkAddress(value);
                            }}
                        >
                            <SelectTrigger id="link-sheet" className="w-full">
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
                    </Field>
                )}
            </FormDialogForm>
        </FormDialog>
    );
}

// A range typed in, or picked with the grid button. `refusal` says why Sheets can't read what was typed, and an empty
// range says so once Apply was pressed.
function RangeField({
    value,
    refusal,
    onValueChange,
    onPick,
}: {
    value: string;
    refusal: string;
    onValueChange: (value: string) => void;
    onPick: () => void;
}) {
    const missing = useFormSubmitted() && !value;
    const problem = refusal || (missing ? NO_RANGE_MESSAGE : '');
    const problemId = useId();
    return (
        <Field>
            <FieldLabel htmlFor="link-cell">Cell range</FieldLabel>
            <InputGroup>
                <InputGroupInput
                    id="link-cell"
                    aria-invalid={problem !== ''}
                    aria-describedby={problem ? problemId : undefined}
                    spellCheck={false}
                    value={value}
                    onChange={(e) => onValueChange(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label="Select cell range" onClick={onPick}>
                        <Grid3x3 />
                    </InputGroupButton>
                </InputGroupAddon>
            </InputGroup>
            {problem && <FieldError id={problemId}>{problem}</FieldError>}
        </Field>
    );
}
