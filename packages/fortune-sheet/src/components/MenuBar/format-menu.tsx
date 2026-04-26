import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import {
    clearSheetRules,
    getFlowdata,
    handleBold,
    handleBorder,
    handleClearFormat,
    handleHorizontalAlign,
    handleItalic,
    handleMerge,
    handleStrikeThrough,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
    handleUnderline,
    handleVerticalAlign,
    locale,
    updateFormat,
} from '../../state';
import { ConditionRules } from '../ConditionFormat/ConditionRules';
import { ManageRules } from '../ConditionFormat/ManageRules';
import { FormatSearch } from '../FormatSearch';

function NumberFormatSubmenu() {
    const { context, setContext, refs, settings } = useContext(WorkbookContext);
    const { showDialog, hideDialog } = useDialog();
    const toolbarFormat = locale(context).format;
    const { currency } = settings;
    const defaultFormat = locale(context).defaultFmt(currency);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Number</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                {defaultFormat.map(({ text, value, example }, ii) => {
                    if (value === 'split') {
                        // biome-ignore lint/suspicious/noArrayIndexKey: separator in static defaultFormat list
                        return <DropdownMenuSeparator key={`split-${ii}`} />;
                    }
                    if (value === 'fmtOtherSelf') {
                        return (
                            <DropdownMenuSub key={value}>
                                <DropdownMenuSubTrigger>{text}</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                                    <DropdownMenuItem
                                        onClick={() => {
                                            showDialog(<FormatSearch onCancel={hideDialog} type="currency" />);
                                        }}
                                    >
                                        {toolbarFormat.moreCurrency}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            showDialog(<FormatSearch onCancel={hideDialog} type="number" />);
                                        }}
                                    >
                                        {toolbarFormat.moreNumber}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            showDialog(<FormatSearch onCancel={hideDialog} type="date" />);
                                        }}
                                    >
                                        {toolbarFormat.moreDateTime}
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        );
                    }
                    return (
                        <DropdownMenuItem
                            key={value}
                            onClick={() => {
                                setContext((ctx) => {
                                    const d = getFlowdata(ctx);
                                    if (d == null) return;
                                    updateFormat(ctx, refs.cellInput.current!, d, 'ct', value);
                                });
                            }}
                        >
                            <div className="flex items-center justify-between w-full">
                                <span>{text}</span>
                                <span className="text-xs opacity-50 pl-6">{example}</span>
                            </div>
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function TextSubmenu() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { toolbar, fontarray } = locale(context);

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
                                        const d = getFlowdata(ctx);
                                        if (!d) return;
                                        updateFormat(ctx, refs.cellInput.current!, d, 'ff', o);
                                    });
                                }}
                            >
                                <span style={{ fontFamily: `'${o}', sans-serif` }}>{o}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{toolbar['font-color'] ?? 'Font color'}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="luckysheet-mousedown-cancel p-3">
                        <ColorPicker
                            value=""
                            resetLabel="Default"
                            onChange={(color) => {
                                if (color) {
                                    setContext((ctx) => {
                                        handleTextColor(ctx, refs.cellInput.current!, color);
                                    });
                                }
                            }}
                        />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function AlignmentSubmenu() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { align } = locale(context);

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

function WrappingSubmenu() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { textWrap } = locale(context);

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
                        if (color) {
                            setContext((ctx) => {
                                handleTextBackground(ctx, refs.cellInput.current!, color);
                            });
                        }
                    }}
                />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function BordersSubmenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { border } = locale(context);

    const borderItems = [
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
        { text: '', value: 'divider' },
    ];

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>Borders</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="luckysheet-mousedown-cancel">
                {borderItems.map(({ text, value }, ii) =>
                    value !== 'divider' ? (
                        <DropdownMenuItem
                            key={value}
                            onClick={() => {
                                setContext((ctx) => {
                                    handleBorder(ctx, value);
                                });
                            }}
                        >
                            {text}
                        </DropdownMenuItem>
                    ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: separator in static border-items list
                        <DropdownMenuSeparator key={`divider-${ii}`} />
                    ),
                )}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

function MergeCellsSubmenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { merge } = locale(context);

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

function ConditionalFormattingSubmenu() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const { conditionformat } = locale(context);

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

                {/* Color Scales / Data Bars — Task 9 inserts here */}
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

            {/* Rotation submenu — Task 8 inserts here */}

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
