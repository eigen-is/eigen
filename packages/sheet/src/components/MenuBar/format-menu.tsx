// The menu bar's Format menu, such as number formats, text styles, alignment, borders and merging. Its items run
// the same toolbar handlers as the format toolbar; conditional formatting has its own file. A command row leads with
// its icon, as in Docs' Format menu, and a choice such as a font size or a number format has none.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { BorderType } from '@workspace/lib/sheets';
import {
    ChoiceMenuItems,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import {
    ALargeSmall,
    AlignCenter,
    AlignLeft,
    AlignRight,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    Baseline,
    Bold,
    Grid2x2,
    Hash,
    Highlighter,
    Italic,
    RemoveFormatting,
    RotateCw,
    Strikethrough,
    TableCellsMerge,
    Type,
    TypeOutline,
    Underline,
    WrapText,
} from 'lucide-react';
import { Fragment, useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { Context, RunStyle } from '../../state';
import {
    FONT_ARRAY,
    getFlowdata,
    HORIZONTAL_ALIGNS,
    handleBold,
    handleBorder,
    handleClearFormat,
    handleFont,
    handleHorizontalAlign,
    handleItalic,
    handleMerge,
    handleNumberFormat,
    handleStrikeThrough,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
    handleUnderline,
    handleVerticalAlign,
    NUMBER_MENU_PRESETS,
    SHEET_HOTKEYS,
    updateFormat,
    VERTICAL_ALIGNS,
} from '../../state';
import { CustomCurrencies } from '../FormatDialogs/CustomCurrencies';
import { CustomDateTimeFormats } from '../FormatDialogs/CustomDateTimeFormats';
import { CustomNumberFormats } from '../FormatDialogs/CustomNumberFormats';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { CustomBorder } from './CustomBorder';
import { ConditionalFormattingSubmenu } from './conditional-formatting-menu';
import { useFormatCells } from './use-format-cells';

const HORIZONTAL_ALIGN_OPTIONS = [
    { value: 'left', label: 'Left', icon: AlignLeft },
    { value: 'center', label: 'Center', icon: AlignCenter },
    { value: 'right', label: 'Right', icon: AlignRight },
] as const;

const VERTICAL_ALIGN_OPTIONS = [
    { value: 'top', label: 'Top', icon: AlignVerticalJustifyStart },
    { value: 'middle', label: 'Middle', icon: AlignVerticalJustifyCenter },
    { value: 'bottom', label: 'Bottom', icon: AlignVerticalJustifyEnd },
] as const;

const WRAP_OPTIONS = [
    { label: 'Overflow', value: 'overflow' },
    { label: 'Wrap', value: 'wrap' },
    { label: 'Clip', value: 'clip' },
];

// Each preset is the cell's `rt`: signed degrees in [-90, 90], up being counterclockwise, or 'vertical'. 0 clears it.
const ROTATIONS: { label: string; value: number | 'vertical' }[] = [
    { label: 'None', value: 0 },
    { label: 'Tilt up', value: 45 },
    { label: 'Tilt down', value: -45 },
    { label: 'Stack vertically', value: 'vertical' },
    { label: 'Rotate up', value: 90 },
    { label: 'Rotate down', value: -90 },
];

const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

const BORDER_GROUPS: { text: string; value: BorderType }[][] = [
    [
        { text: 'Top border', value: 'border-top' },
        { text: 'Bottom border', value: 'border-bottom' },
        { text: 'Left border', value: 'border-left' },
        { text: 'Right border', value: 'border-right' },
    ],
    [
        { text: 'No border', value: 'border-none' },
        { text: 'All borders', value: 'border-all' },
        { text: 'Outside border', value: 'border-outside' },
    ],
    [
        { text: 'Inside border', value: 'border-inside' },
        { text: 'Horizontal borders', value: 'border-horizontal' },
        { text: 'Vertical borders', value: 'border-vertical' },
        { text: 'Slash border', value: 'border-slash' },
    ],
];

const MERGES = [
    { text: 'Merge all', value: 'merge-all' },
    { text: 'Merge horizontally', value: 'merge-horizontal' },
    { text: 'Merge vertically', value: 'merge-vertical' },
    { text: 'Unmerge', value: 'merge-cancel' },
];

// Sets one property of every selected cell, such as its wrapping or rotation.
function setCellProperty(ctx: Context, input: HTMLDivElement, attr: 'tb' | 'rt', value: string | number) {
    const flowdata = getFlowdata(ctx);
    if (flowdata) updateFormat(ctx, input, flowdata, attr, value);
}

function NumberFormatSubmenu() {
    const format = useFormatCells();
    const { showDialog } = useDialog();
    const activeFa = useAnchorCell()?.ct?.fa ?? 'General';

    const customItems = [
        { text: 'Custom currency', dialog: <CustomCurrencies /> },
        { text: 'Custom date and time', dialog: <CustomDateTimeFormats /> },
        { text: 'Custom number format', dialog: <CustomNumberFormats /> },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Hash className="h-4 w-4" /> Number
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {NUMBER_MENU_PRESETS.map((group) => (
                    <Fragment key={group[0].value}>
                        <DropdownMenuSeparator />
                        <ChoiceMenuItems
                            value={activeFa}
                            options={group.map(({ text, value, example }) => ({
                                value,
                                label: (
                                    <>
                                        <span>{text}</span>
                                        <span className="ml-auto pl-6 text-xs opacity-50">{example}</span>
                                    </>
                                ),
                            }))}
                            onChange={(value) => format((ctx, input) => handleNumberFormat(ctx, input, value))}
                        />
                    </Fragment>
                ))}
                <DropdownMenuSeparator />
                {customItems.map(({ text, dialog }) => (
                    <DropdownMenuItem key={text} inset onClick={() => showDialog(dialog)}>
                        {text}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function TextSubmenu({ caretColor }: { caretColor: string | undefined }) {
    const format = useFormatCells();
    const anchorColor = useAnchorCell()?.fc;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Type className="h-4 w-4" /> Text
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuItem onClick={() => format(handleBold)}>
                    <Bold className="h-4 w-4" /> Bold
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.bold)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => format(handleItalic)}>
                    <Italic className="h-4 w-4" /> Italic
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.italic)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => format(handleUnderline)}>
                    <Underline className="h-4 w-4" /> Underline
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.underline)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => format(handleStrikeThrough)}>
                    <Strikethrough className="h-4 w-4" /> Strikethrough
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <TypeOutline className="h-4 w-4" /> Font
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel max-h-[50vh] overflow-y-auto">
                        {FONT_ARRAY.map((font) => (
                            <DropdownMenuItem
                                key={font}
                                onClick={() => format((ctx, input) => handleFont(ctx, input, font))}
                            >
                                <span style={{ fontFamily: getFontFamily(font) }}>{font}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <ColorPickerMenuItem
                    icon={Baseline}
                    label="Text color"
                    value={caretColor ?? anchorColor ?? ''}
                    resetLabel="Default"
                    contentClassName="sheet-mousedown-cancel"
                    onChange={(color) => format((ctx, input) => handleTextColor(ctx, input, color))}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

// The anchor cell's alignment is checked, as Docs' Format › Align and indent checks the paragraph's.
function AlignmentSubmenu() {
    const format = useFormatCells();
    const cell = useAnchorCell();

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <AlignLeft className="h-4 w-4" /> Alignment
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <ChoiceMenuItems
                    value={cell?.ht == null ? undefined : HORIZONTAL_ALIGNS[cell.ht]}
                    options={HORIZONTAL_ALIGN_OPTIONS.map(({ value, label, icon: Icon }) => ({
                        value,
                        label: (
                            <>
                                <Icon className="h-4 w-4" /> {label}
                            </>
                        ),
                    }))}
                    onChange={(value) => format((ctx, input) => handleHorizontalAlign(ctx, input, value))}
                />
                <DropdownMenuSeparator />
                <ChoiceMenuItems
                    value={cell?.vt == null ? undefined : VERTICAL_ALIGNS[cell.vt]}
                    options={VERTICAL_ALIGN_OPTIONS.map(({ value, label, icon: Icon }) => ({
                        value,
                        label: (
                            <>
                                <Icon className="h-4 w-4" /> {label}
                            </>
                        ),
                    }))}
                    onChange={(value) => format((ctx, input) => handleVerticalAlign(ctx, input, value))}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function WrappingSubmenu() {
    const format = useFormatCells();

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <WrapText className="h-4 w-4" /> Wrapping
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {WRAP_OPTIONS.map(({ label, value }) => (
                    <DropdownMenuItem
                        key={value}
                        onClick={() => format((ctx, input) => setCellProperty(ctx, input, 'tb', value))}
                    >
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function RotationSubmenu() {
    const format = useFormatCells();

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <RotateCw className="h-4 w-4" /> Text rotate
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {ROTATIONS.map(({ label, value }) => (
                    <DropdownMenuItem
                        key={label}
                        onClick={() => format((ctx, input) => setCellProperty(ctx, input, 'rt', value))}
                    >
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function FontSizeSubmenu() {
    const format = useFormatCells();

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <ALargeSmall className="h-4 w-4" /> Font size
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {FONT_SIZES.map((size) => (
                    <DropdownMenuItem
                        key={size}
                        onClick={() => format((ctx, input) => handleTextSize(ctx, input, size))}
                    >
                        {size}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function FillColorItem() {
    const format = useFormatCells();
    const fillColor = useAnchorCell()?.bg ?? '';

    return (
        <ColorPickerMenuItem
            icon={Highlighter}
            label="Fill color"
            value={fillColor}
            resetLabel="Default"
            contentClassName="sheet-mousedown-cancel"
            onChange={(color) => format((ctx, input) => handleTextBackground(ctx, input, color))}
        />
    );
}

function BordersSubmenu() {
    const { setContext } = useContext(WorkbookContext);
    const [customColor, setCustomColor] = useState('#000000');
    const [customStyle, setCustomStyle] = useState('1');

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Grid2x2 className="h-4 w-4" /> Borders
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {BORDER_GROUPS.map((group) => (
                    <Fragment key={group[0].value}>
                        <DropdownMenuSeparator />
                        {group.map(({ text, value }) => (
                            <DropdownMenuItem
                                key={value}
                                onClick={() => setContext((ctx) => handleBorder(ctx, value, customColor, customStyle))}
                            >
                                {text}
                            </DropdownMenuItem>
                        ))}
                    </Fragment>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Custom border…</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        <CustomBorder
                            onPick={(color?: string, style?: string) => {
                                if (color) setCustomColor(color);
                                if (style) setCustomStyle(style);
                            }}
                        />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function MergeCellsSubmenu() {
    const { setContext } = useContext(WorkbookContext);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <TableCellsMerge className="h-4 w-4" /> Merge cells
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {MERGES.map(({ text, value }) => (
                    <DropdownMenuItem key={value} onClick={() => setContext((ctx) => handleMerge(ctx, value))}>
                        {text}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

// `caret` is the style at the open cell editor's caret, null while no cell is open.
export function FormatMenu({ caret }: { caret: RunStyle | null }) {
    const { setContext } = useContext(WorkbookContext);

    return (
        <>
            <NumberFormatSubmenu />
            <TextSubmenu caretColor={caret?.fc} />
            <AlignmentSubmenu />
            <WrappingSubmenu />
            <RotationSubmenu />

            <DropdownMenuSeparator />

            <FontSizeSubmenu />
            <FillColorItem />
            <BordersSubmenu />
            <MergeCellsSubmenu />

            <DropdownMenuSeparator />

            <ConditionalFormattingSubmenu />

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => setContext(handleClearFormat)}>
                <RemoveFormatting className="h-4 w-4" /> Clear formatting
                <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.clearFormatting)}</DropdownMenuShortcut>
            </DropdownMenuItem>
        </>
    );
}
