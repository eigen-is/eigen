// The Conditional formatting submenu of the Format menu: the highlight and item-selection rules that open their
// dialog, the color scale and data bar presets, Manage rules and Delete rule.

import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import type { ConditionRuleType } from '../../state';
import { applyColorScalePreset, applyDataBarPreset, CF_PRESETS, clearSheetRules } from '../../state';
import { ConditionRules, RULE_COPY } from '../ConditionFormat/ConditionRules';
import { ManageRules } from '../ConditionFormat/ManageRules';

// The label is RULE_COPY's, so the menu row and the dialog it opens can't drift.
type ConditionRuleItem = { text: ConditionRuleType; value: string };

const HIGHLIGHT_CELL_RULES: ConditionRuleItem[] = [
    { text: 'greaterThan', value: '>' },
    { text: 'lessThan', value: '<' },
    { text: 'between', value: '[]' },
    { text: 'equal', value: '=' },
    { text: 'textContains', value: '()' },
    { text: 'occurrenceDate', value: 'YTD' },
    { text: 'duplicateValue', value: '##' },
];

const ITEM_SELECTION_RULES: ConditionRuleItem[] = [
    { text: 'top10', value: 'Top 10' },
    { text: 'top10_percent', value: 'Top 10%' },
    { text: 'last10', value: 'Last 10' },
    { text: 'last10_percent', value: 'Last 10%' },
    { text: 'aboveAverage', value: 'Above' },
    { text: 'belowAverage', value: 'Below' },
];

// Each label names the stops in the order the swatch draws them: the color of the highest value first.
const COLOR_SCALE_PRESETS = [
    { key: 'colorGradation_1', label: 'Red-yellow-green color gradation' },
    { key: 'colorGradation_2', label: 'Green-yellow-red color gradation' },
    { key: 'colorGradation_3', label: 'Red-white-green color gradation' },
    { key: 'colorGradation_4', label: 'Green-white-red color gradation' },
    { key: 'colorGradation_5', label: 'Red-white-blue color gradation' },
    { key: 'colorGradation_6', label: 'Blue-white-red color gradation' },
    { key: 'colorGradation_7', label: 'Red-white color gradation' },
    { key: 'colorGradation_8', label: 'White-red color gradation' },
    { key: 'colorGradation_9', label: 'White-green color gradation' },
    { key: 'colorGradation_10', label: 'Green-white color gradation' },
    { key: 'colorGradation_11', label: 'Yellow-green color gradation' },
    { key: 'colorGradation_12', label: 'Green-yellow color gradation' },
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
        <div className="flex w-12 h-4 rounded-sm overflow-hidden border border-border">
            {colors.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static palette — order is meaningful, no stable id
                <div key={`${presetKey}-${i}`} className="flex-1" style={{ backgroundColor: c }} />
            ))}
        </div>
    );
}

export function ConditionalFormattingSubmenu() {
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
                                    <span>{RULE_COPY[v.text].label}</span>
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
                                    <span>{RULE_COPY[v.text].label}</span>
                                    <span className="text-xs opacity-50 ml-4">{v.value}</span>
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Color scale</DropdownMenuSubTrigger>
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
                    <DropdownMenuSubTrigger>Data bar</DropdownMenuSubTrigger>
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

                <DropdownMenuItem onClick={() => showDialog(<ManageRules />)}>Manage rules</DropdownMenuItem>

                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Delete rule</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="sheet-mousedown-cancel">
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                                setContext((ctx) => {
                                    clearSheetRules(ctx);
                                });
                            }}
                        >
                            Delete sheet rules
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
