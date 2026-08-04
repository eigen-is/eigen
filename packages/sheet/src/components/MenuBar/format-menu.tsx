import type { BorderType } from '@workspace/lib/sheets';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { Check } from 'lucide-react';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import {
    applyColorScalePreset,
    applyDataBarPreset,
    CF_PRESETS,
    clearSheetRules,
    en,
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
    updateFormat,
} from '../../state';
import { ConditionRules } from '../ConditionFormat/ConditionRules';
import { ManageRules } from '../ConditionFormat/ManageRules';
import { CustomCurrencies } from '../FormatDialogs/CustomCurrencies';
import { CustomDateTimeFormats } from '../FormatDialogs/CustomDateTimeFormats';
import { CustomNumberFormats } from '../FormatDialogs/CustomNumberFormats';
import { useAnchorCell } from '../FormatDialogs/useAnchorCell';
import { CustomBorder } from './CustomBorder';

function NumberFormatSubmenu() {
    const { setContext, refs, settings } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const toolbarFormat = en.format;
    const { currency } = settings;
    const defaultFormat = en.defaultFmt(currency);

    const anchor = useAnchorCell();
    const activeFa = anchor?.ct?.fa ?? 'General';

    const customItems = [
        { text: toolbarFormat.customCurrency, dialog: <CustomCurrencies /> },
        { text: toolbarFormat.customDateTime, dialog: <CustomDateTimeFormats /> },
        { text: toolbarFormat.customNumber, dialog: <CustomNumberFormats /> },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Number</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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
    const { toolbar, fontarray } = en;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Text</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleBold(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    {toolbar.bold}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleItalic(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    {toolbar.italic}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleUnderline(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    {toolbar.underline}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleStrikeThrough(ctx, refs.cellInput.current!);
                        });
                    }}
                >
                    {toolbar['strike-through']}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Font</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel max-h-[50vh] overflow-y-auto">
                        {fontarray.map((o) => (
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

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{toolbar['font-color']}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel p-3">
                        <ColorPicker
                            value=""
                            resetLabel="Default"
                            onChange={(color) => {
                                setContext((ctx) => {
                                    handleTextColor(ctx, refs.cellInput.current!, color);
                                });
                            }}
                        />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function AlignmentSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);
    const { align } = en;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Alignment</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'left');
                        });
                    }}
                >
                    {align.left}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'center');
                        });
                    }}
                >
                    {align.center}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleHorizontalAlign(ctx, refs.cellInput.current!, 'right');
                        });
                    }}
                >
                    {align.right}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'top');
                        });
                    }}
                >
                    {align.top}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'middle');
                        });
                    }}
                >
                    {align.middle}
                </DropdownMenuItem>
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            handleVerticalAlign(ctx, refs.cellInput.current!, 'bottom');
                        });
                    }}
                >
                    {align.bottom}
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function RotationSubmenu() {
    const { setContext, refs } = useContext(WorkbookContext);
    const { toolbar, rotation } = en;

    // Each preset writes Cell.rt directly: signed degrees in [-90, 90] or 'vertical'.
    // Positive = CCW / "up", negative = CW / "down". 0 clears rotation.
    const presets: { label: string; value: number | 'vertical' }[] = [
        { label: rotation.none, value: 0 },
        { label: rotation.angleup, value: 45 },
        { label: rotation.angledown, value: -45 },
        { label: rotation.vertical, value: 'vertical' },
        { label: rotation.rotationUp, value: 90 },
        { label: rotation.rotationDown, value: -90 },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>{toolbar.textRotate}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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
    const { textWrap } = en;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Wrapping</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                <DropdownMenuItem
                    onClick={() => {
                        setContext((ctx) => {
                            const d = getFlowdata(ctx);
                            if (d == null) return;
                            updateFormat(ctx, refs.cellInput.current!, d, 'tb', 'overflow');
                        });
                    }}
                >
                    {textWrap.overflow}
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
                    {textWrap.wrap}
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
                    {textWrap.clip}
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
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Fill color</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel p-3">
                <ColorPicker
                    value=""
                    resetLabel="Default"
                    onChange={(color) => {
                        setContext((ctx) => {
                            handleTextBackground(ctx, refs.cellInput.current!, color);
                        });
                    }}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function BordersSubmenu() {
    const { setContext } = useContext(WorkbookContext);
    const { border } = en;
    const [customColor, setCustomColor] = useState('#000000');
    const [customStyle, setCustomStyle] = useState('1');

    const borderItems: { text: string; value: BorderType | 'divider' }[] = [
        { text: border.borderTop, value: 'border-top' },
        { text: border.borderBottom, value: 'border-bottom' },
        { text: border.borderLeft, value: 'border-left' },
        { text: border.borderRight, value: 'border-right' },
        { text: '', value: 'divider' },
        { text: border.borderNone, value: 'border-none' },
        { text: border.borderAll, value: 'border-all' },
        { text: border.borderOutside, value: 'border-outside' },
        { text: '', value: 'divider' },
        { text: border.borderInside, value: 'border-inside' },
        { text: border.borderHorizontal, value: 'border-horizontal' },
        { text: border.borderVertical, value: 'border-vertical' },
        { text: border.borderSlash, value: 'border-slash' },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Borders</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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
    const { merge } = en;

    const mergeItems = [
        { text: merge.mergeAll, value: 'merge-all' },
        { text: merge.mergeH, value: 'merge-horizontal' },
        { text: merge.mergeV, value: 'merge-vertical' },
        { text: merge.mergeCancel, value: 'merge-cancel' },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Merge cells</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
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

const COLOR_SCALE_PRESETS = [
    'colorGradation_1',
    'colorGradation_2',
    'colorGradation_3',
    'colorGradation_4',
    'colorGradation_5',
    'colorGradation_6',
    'colorGradation_7',
    'colorGradation_8',
    'colorGradation_9',
    'colorGradation_10',
    'colorGradation_11',
    'colorGradation_12',
] as const;

const DATA_BAR_PRESETS = [
    'solidColorDataBar_1',
    'solidColorDataBar_2',
    'solidColorDataBar_3',
    'solidColorDataBar_4',
    'solidColorDataBar_5',
    'solidColorDataBar_6',
] as const;

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
    const { conditionformat } = en;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Conditional formatting</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{conditionformat.highlightCellRules}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                        {[
                            { text: 'greaterThan', value: '>' },
                            { text: 'lessThan', value: '<' },
                            { text: 'between', value: '[]' },
                            { text: 'equal', value: '=' },
                            { text: 'textContains', value: '()' },
                            { text: 'occurrenceDate', value: conditionformat.yesterday },
                            { text: 'duplicateValue', value: '##' },
                        ].map((v) => (
                            <DropdownMenuItem
                                key={v.text}
                                onClick={() => {
                                    showDialog(<ConditionRules type={v.text} />);
                                }}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <span>{conditionformat[v.text as keyof typeof conditionformat]}</span>
                                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{conditionformat.itemSelectionRules}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                        {[
                            { text: 'top10', value: conditionformat.top10 },
                            { text: 'top10_percent', value: conditionformat.top10_percent },
                            { text: 'last10', value: conditionformat.last10 },
                            { text: 'last10_percent', value: conditionformat.last10_percent },
                            { text: 'aboveAverage', value: conditionformat.above },
                            { text: 'belowAverage', value: conditionformat.below },
                        ].map((v) => (
                            <DropdownMenuItem
                                key={v.text}
                                onClick={() => {
                                    showDialog(<ConditionRules type={v.text} />);
                                }}
                            >
                                <div className="flex items-center justify-between w-full">
                                    <span>{conditionformat[v.text as keyof typeof conditionformat]}</span>
                                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{conditionformat.colorGradation}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                        {COLOR_SCALE_PRESETS.map((preset) => (
                            <DropdownMenuItem
                                key={preset}
                                onClick={() => setContext((draftCtx) => applyColorScalePreset(draftCtx, preset))}
                            >
                                <ColorScaleSwatch presetKey={preset} />
                                <span>{conditionformat[preset]}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{conditionformat.dataBar}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                        {DATA_BAR_PRESETS.map((preset) => (
                            <DropdownMenuItem
                                key={preset}
                                onClick={() => setContext((draftCtx) => applyDataBarPreset(draftCtx, preset))}
                            >
                                <ColorScaleSwatch presetKey={preset} />
                                <span>{conditionformat[preset]}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={() => showDialog(<ManageRules />)}>
                    {conditionformat.manageRules}
                </DropdownMenuItem>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{conditionformat.deleteRule}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                        <DropdownMenuItem
                            onClick={() => {
                                setContext((ctx) => {
                                    clearSheetRules(ctx);
                                });
                            }}
                        >
                            {conditionformat.deleteSheetRule}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => showDialog(<ManageRules />)}>
                            {conditionformat.manageRules}
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
