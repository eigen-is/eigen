// The menu bar's Format menu, such as number formats, text styles, alignment, borders and merging. Its items run
// the same toolbar handlers as the format toolbar; conditional formatting has its own file.

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
import { Fragment, useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { RunStyle } from '../../state';
import {
    FONT_ARRAY,
    getFlowdata,
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
} from '../../state';
import { CustomCurrencies } from '../FormatDialogs/CustomCurrencies';
import { CustomDateTimeFormats } from '../FormatDialogs/CustomDateTimeFormats';
import { CustomNumberFormats } from '../FormatDialogs/CustomNumberFormats';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { CustomBorder } from './CustomBorder';
import { ConditionalFormattingSubmenu } from './conditional-formatting-menu';

function NumberFormatSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);
    const { showDialog } = useDialog();

    const anchor = useAnchorCell();
    const activeFa = anchor?.ct?.fa ?? 'General';

    const customItems = [
        { text: 'Custom currency', dialog: <CustomCurrencies /> },
        { text: 'Custom date and time', dialog: <CustomDateTimeFormats /> },
        { text: 'Custom number format', dialog: <CustomNumberFormats /> },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Number</DropdownMenuSubTrigger>
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
                            onChange={(value) =>
                                setContext((ctx) => {
                                    const input = refs.cellInput.current;
                                    if (input) handleNumberFormat(ctx, input, value);
                                })
                            }
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
    const { setContext, refs } = useContext(WorkbookContext);
    const anchorColor = useAnchorCell()?.fc;
    const textColor = caretColor ?? anchorColor ?? '';

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Text</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleBold(ctx, input);
                        });
                    }}
                >
                    Bold
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.bold)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleItalic(ctx, input);
                        });
                    }}
                >
                    Italic
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.italic)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleUnderline(ctx, input);
                        });
                    }}
                >
                    Underline
                    <DropdownMenuShortcut>{formatForDisplay(SHEET_HOTKEYS.underline)}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleStrikeThrough(ctx, input);
                        });
                    }}
                >
                    Strikethrough
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Font</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel max-h-[50vh] overflow-y-auto">
                        {FONT_ARRAY.map((o) => (
                            <DropdownMenuItem
                                key={o}
                                onClick={() => {
                                    setContext((ctx) => {
                                        const input = refs.cellInput.current;
                                        if (input) handleFont(ctx, input, o);
                                    });
                                }}
                            >
                                <span style={{ fontFamily: getFontFamily(o) }}>{o}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <ColorPickerMenuItem
                    label="Font color"
                    value={textColor}
                    resetLabel="Default"
                    contentClassName="sheet-mousedown-cancel"
                    onChange={(color) => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleTextColor(ctx, input, color);
                        });
                    }}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function AlignmentSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Alignment</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleHorizontalAlign(ctx, input, 'left');
                        });
                    }}
                >
                    Left
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleHorizontalAlign(ctx, input, 'center');
                        });
                    }}
                >
                    Center
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleHorizontalAlign(ctx, input, 'right');
                        });
                    }}
                >
                    Right
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleVerticalAlign(ctx, input, 'top');
                        });
                    }}
                >
                    Top
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleVerticalAlign(ctx, input, 'middle');
                        });
                    }}
                >
                    Middle
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const input = refs.cellInput.current;
                            if (input) handleVerticalAlign(ctx, input, 'bottom');
                        });
                    }}
                >
                    Bottom
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function RotationSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);

    // Each preset writes Cell.rt directly: signed degrees in [-90, 90] or 'vertical'.
    // Positive = CCW / "up", negative = CW / "down". 0 clears rotation.
    const presets: { label: string; value: number | 'vertical' }[] = [
        { label: 'None', value: 0 },
        { label: 'Tilt up', value: 45 },
        { label: 'Tilt down', value: -45 },
        { label: 'Stack vertically', value: 'vertical' },
        { label: 'Rotate up', value: 90 },
        { label: 'Rotate down', value: -90 },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Text rotate</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {presets.map(({ label, value }) => (
                    <DropdownMenuItem
                        key={label}
                        onClick={() => {
                            setContext((ctx) => {
                                const d = getFlowdata(ctx);
                                const input = refs.cellInput.current;
                                if (d == null || !input) return;
                                updateFormat(ctx, input, d, 'rt', value);
                            });
                        }}
                    >
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function WrappingSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Wrapping</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            const input = refs.cellInput.current;
                            if (d == null || !input) return;
                            updateFormat(ctx, input, d, 'tb', 'overflow');
                        });
                    }}
                >
                    Overflow
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            const input = refs.cellInput.current;
                            if (d == null || !input) return;
                            const canvas = refs.canvas.current?.getContext('2d') ?? undefined;
                            updateFormat(ctx, input, d, 'tb', 'wrap', canvas);
                        });
                    }}
                >
                    Wrap
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            const input = refs.cellInput.current;
                            if (d == null || !input) return;
                            updateFormat(ctx, input, d, 'tb', 'clip');
                        });
                    }}
                >
                    Clip
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function FontSizeSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Font size</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {[9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72].map((num) => (
                    <DropdownMenuItem
                        key={num}
                        onClick={() => {
                            setContext((ctx) => {
                                const input = refs.cellInput.current;
                                const canvas = refs.canvas.current?.getContext('2d') ?? undefined;
                                if (input) handleTextSize(ctx, input, num, canvas);
                            });
                        }}
                    >
                        {num}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function FillColorItem() {
    const { setContext, refs } = useContext(WorkbookContext);
    const fillColor = useAnchorCell()?.bg ?? '';

    return (
        <ColorPickerMenuItem
            label="Fill color"
            value={fillColor}
            resetLabel="Default"
            contentClassName="sheet-mousedown-cancel"
            onChange={(color) => {
                setContext((ctx) => {
                    const input = refs.cellInput.current;
                    if (input) handleTextBackground(ctx, input, color);
                });
            }}
        />
    );
}

function BordersSubmenu() {
    const { setContext } = useContext(WorkbookContext);
    const [customColor, setCustomColor] = useState('#000000');
    const [customStyle, setCustomStyle] = useState('1');

    const borderItems: { text: string; value: BorderType | 'divider' }[] = [
        { text: 'Top border', value: 'border-top' },
        { text: 'Bottom border', value: 'border-bottom' },
        { text: 'Left border', value: 'border-left' },
        { text: 'Right border', value: 'border-right' },
        { text: '', value: 'divider' },
        { text: 'No border', value: 'border-none' },
        { text: 'All borders', value: 'border-all' },
        { text: 'Outside border', value: 'border-outside' },
        { text: '', value: 'divider' },
        { text: 'Inside border', value: 'border-inside' },
        { text: 'Horizontal borders', value: 'border-horizontal' },
        { text: 'Vertical borders', value: 'border-vertical' },
        { text: 'Slash border', value: 'border-slash' },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Borders</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {borderItems.map(({ text, value }, ii) =>
                    value === 'divider' ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: separator in static border-items list
                        <DropdownMenuSeparator key={`divider-${ii}`} />
                    ) : (
                        <DropdownMenuItem
                            key={value}
                            onClick={() => {
                                setContext((ctx) => {
                                    handleBorder(ctx, value, customColor, customStyle);
                                });
                            }}
                        >
                            {text}
                        </DropdownMenuItem>
                    ),
                )}
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

    const mergeItems = [
        { text: 'Merge all', value: 'merge-all' },
        { text: 'Merge horizontally', value: 'merge-horizontal' },
        { text: 'Merge vertically', value: 'merge-vertical' },
        { text: 'Unmerge', value: 'merge-cancel' },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Merge cells</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                {mergeItems.map(({ text, value }) => (
                    <DropdownMenuItem
                        key={value}
                        onClick={() => {
                            setContext((ctx) => {
                                handleMerge(ctx, value);
                            });
                        }}
                    >
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

            <DropdownMenuItem
                onClick={() => {
                    setContext((ctx) => {
                        handleClearFormat(ctx);
                    });
                }}
            >
                Clear formatting
            </DropdownMenuItem>
        </>
    );
}
