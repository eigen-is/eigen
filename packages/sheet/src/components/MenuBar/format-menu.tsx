import type { BorderType } from '@workspace/lib/sheets';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Check } from 'lucide-react';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import {
    applyColorScalePreset,
    applyDataBarPreset,
    CF_PRESETS,
    clearSheetRules,
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
    numberFormatPresets,
    updateFormat,
} from '../../state';
import { ColorPickerMenuItem } from '../ColorPickerMenuItem';
import { ConditionRules, type ConditionRuleType } from '../ConditionFormat/ConditionRules';
import { ManageRules } from '../ConditionFormat/ManageRules';
import { CustomCurrencies } from '../FormatDialogs/CustomCurrencies';
import { CustomDateTimeFormats } from '../FormatDialogs/CustomDateTimeFormats';
import { CustomNumberFormats } from '../FormatDialogs/CustomNumberFormats';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { CustomBorder } from './CustomBorder';

function NumberFormatSubmenu() {
    const { setContext, refs, settings } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const { currency } = settings;
    const defaultFormat = numberFormatPresets(currency);

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
                {defaultFormat.map(({ text, value, example }, ii) => {
                    if (value === 'split') {
                        // biome-ignore lint/suspicious/noArrayIndexKey: separator in static defaultFormat list
                        return <DropdownMenuSeparator key={`split-${ii}`} />;
                    }
                    return (
                        <DropdownMenuItem
                            key={value}
                            onClick={() => {
                                setContext((ctx) => {
                                    handleNumberFormat(ctx, refs.cellInput.current!, value);
                                });
                            }}
                        >
                            <span className="flex w-4 shrink-0 items-center justify-center">
                                {value === activeFa && <Check className="size-4" />}
                            </span>
                            <span>{text}</span>
                            <span className="ml-auto pl-6 text-xs opacity-50">{example}</span>
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                {customItems.map(({ text, dialog }) => (
                    <DropdownMenuItem key={text} onClick={() => showDialog(dialog)}>
                        <span className="w-4 shrink-0" />
                        <span>{text}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function TextSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);
    const textColor = useAnchorCell()?.fc ?? '';

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Text</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleBold(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    Bold (Ctrl+B)
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleItalic(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    Italic (Ctrl+I)
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleUnderline(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    Underline
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleStrikeThrough(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    Strikethrough (Alt+Shift+5)
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
                                        handleFont(ctx, refs.cellInput.current!, o);
                                    });
                                }}
                            >
                                <span style={{ fontFamily: `'${o}', sans-serif` }}>{o}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <ColorPickerMenuItem
                    label="Font color"
                    value={textColor}
                    resetLabel="Default"
                    onChange={(color) => {
                        setContext((ctx) => {
                            handleTextColor(ctx, refs.cellInput.current!, color);
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
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'left');
                        });
                    }}
                >
                    left
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'center');
                        });
                    }}
                >
                    center
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'right');
                        });
                    }}
                >
                    right
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'top');
                        });
                    }}
                >
                    Top
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'middle');
                        });
                    }}
                >
                    Middle
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'bottom');
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
        { label: 'Tilt Up', value: 45 },
        { label: 'Tilt Down', value: -45 },
        { label: 'Stack Vertically', value: 'vertical' },
        { label: 'Rotate Up', value: 90 },
        { label: 'Rotate Down', value: -90 },
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
                                if (d == null) return;
                                updateFormat(ctx, refs.cellInput.current!, d, 'rt', value);
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
                            if (d == null) return;
                            updateFormat(ctx, refs.cellInput.current!, d, 'tb', 'overflow');
                        });
                    }}
                >
                    Overflow
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            if (d == null) return;
                            updateFormat(ctx, refs.cellInput.current!, d, 'tb', 'wrap');
                        });
                    }}
                >
                    Wrap
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            if (d == null) return;
                            updateFormat(ctx, refs.cellInput.current!, d, 'tb', 'clip');
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
                                handleTextSize(ctx, refs.cellInput.current!, num);
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
            onChange={(color) => {
                setContext((ctx) => {
                    handleTextBackground(ctx, refs.cellInput.current!, color);
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
        { text: 'Merge Horizontally', value: 'merge-horizontal' },
        { text: 'Merge Vertically', value: 'merge-vertical' },
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

type ConditionRuleItem = { text: ConditionRuleType; label: string; value: string };

const HIGHLIGHT_CELL_RULES: ConditionRuleItem[] = [
    { text: 'greaterThan', label: 'Greater than', value: '>' },
    { text: 'lessThan', label: 'Less than', value: '<' },
    { text: 'between', label: 'Between', value: '[]' },
    { text: 'equal', label: 'Equal', value: '=' },
    { text: 'textContains', label: 'Text contains', value: '()' },
    { text: 'occurrenceDate', label: 'Date', value: 'YTD' },
    { text: 'duplicateValue', label: 'Duplicate value', value: '##' },
];

const ITEM_SELECTION_RULES: ConditionRuleItem[] = [
    { text: 'top10', label: 'Top 10', value: 'Top 10' },
    { text: 'top10_percent', label: 'Top 10%', value: 'Top 10%' },
    { text: 'last10', label: 'Last 10', value: 'Last 10' },
    { text: 'last10_percent', label: 'Last 10%', value: 'Last 10%' },
    { text: 'aboveAverage', label: 'Above average', value: 'Above' },
    { text: 'belowAverage', label: 'Below average', value: 'Below' },
];

const COLOR_SCALE_PRESETS = [
    { key: 'colorGradation_1', label: 'Green-yellow-red color gradation' },
    { key: 'colorGradation_2', label: 'Red-yellow-green color gradation' },
    { key: 'colorGradation_3', label: 'Green-white-red color gradation' },
    { key: 'colorGradation_4', label: 'Red-white-green color gradation' },
    { key: 'colorGradation_5', label: 'Blue-white-red color gradation' },
    { key: 'colorGradation_6', label: 'Red-white-blue color gradation' },
    { key: 'colorGradation_7', label: 'White-red color gradation' },
    { key: 'colorGradation_8', label: 'Red-white color gradation' },
    { key: 'colorGradation_9', label: 'Green-white color gradation' },
    { key: 'colorGradation_10', label: 'White-green color gradation' },
    { key: 'colorGradation_11', label: 'Green-yellow color gradation' },
    { key: 'colorGradation_12', label: 'Yellow-green color gradation' },
];

const DATA_BAR_PRESETS = [
    { key: 'solidColorDataBar_1', label: 'Blue data bar' },
    { key: 'solidColorDataBar_2', label: 'Green data bar' },
    { key: 'solidColorDataBar_3', label: 'Red data bar' },
    { key: 'solidColorDataBar_4', label: 'Orange data bar' },
    { key: 'solidColorDataBar_5', label: 'Light blue data bar' },
    { key: 'solidColorDataBar_6', label: 'Purple data bar' },
];

function ColorScaleSwatch({ presetKey }: { presetKey: string }) {
    const colors = CF_PRESETS[presetKey] ?? [];
    return (
        <div className="flex w-12 h-4 mr-2 rounded-sm overflow-hidden border border-border">
            {colors.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static palette — order is meaningful, no stable id
                <div key={`${presetKey}-${i}`} className="flex-1" style={{ backgroundColor: c }} />
            ))}
        </div>
    );
}

function ConditionalFormattingSubmenu() {
    const { setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Conditional formatting</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="sheet-mousedown-cancel">
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Highlight cell rules</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        {HIGHLIGHT_CELL_RULES.map((v) => (
                            <DropdownMenuItem
                                key={v.text}
                                onClick={() => {
                                    showDialog(<ConditionRules type={v.text} />);
                                }}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <span>{v.label}</span>
                                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Item selection rules</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        {ITEM_SELECTION_RULES.map((v) => (
                            <DropdownMenuItem
                                key={v.text}
                                onClick={() => {
                                    showDialog(<ConditionRules type={v.text} />);
                                }}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <span>{v.label}</span>
                                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>color gradation</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        {COLOR_SCALE_PRESETS.map(({ key, label }) => (
                            <DropdownMenuItem
                                key={key}
                                onClick={() => setContext((draftCtx) => applyColorScalePreset(draftCtx, key))}
                            >
                                <ColorScaleSwatch presetKey={key} />
                                <span>{label}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>data bar</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        {DATA_BAR_PRESETS.map(({ key, label }) => (
                            <DropdownMenuItem
                                key={key}
                                onClick={() => setContext((draftCtx) => applyDataBarPreset(draftCtx, key))}
                            >
                                <ColorScaleSwatch presetKey={key} />
                                <span>{label}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={() => showDialog(<ManageRules />)}>Management rules</DropdownMenuItem>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Delete rule</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        <DropdownMenuItem
                            onClick={() => {
                                setContext((ctx) => {
                                    clearSheetRules(ctx);
                                });
                            }}
                        >
                            Delete sheet rule
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => showDialog(<ManageRules />)}>
                            Management rules
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export function FormatMenu() {
    const { setContext } = useContext(WorkbookContext);

    return (
        <>
            <NumberFormatSubmenu />
            <TextSubmenu />
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
