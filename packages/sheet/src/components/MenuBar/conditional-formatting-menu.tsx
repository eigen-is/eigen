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

// The label is RULE_COPY's, so the menu row and the dialog it opens can't drift. The hint is the short text the row
// shows after the label.
type ConditionRuleItem = { type: ConditionRuleType; hint: string };

const HIGHLIGHT_CELL_RULES: ConditionRuleItem[] = [
    { type: 'greaterThan', hint: '>' },
    { type: 'lessThan', hint: '<' },
    { type: 'between', hint: '[]' },
    { type: 'equal', hint: '=' },
    { type: 'textContains', hint: '()' },
    { type: 'occurrenceDate', hint: 'YTD' },
    { type: 'duplicateValue', hint: '##' },
];

const ITEM_SELECTION_RULES: ConditionRuleItem[] = [
    { type: 'top10', hint: 'Top 10' },
    { type: 'top10_percent', hint: 'Top 10%' },
    { type: 'last10', hint: 'Last 10' },
    { type: 'last10_percent', hint: 'Last 10%' },
    { type: 'aboveAverage', hint: 'Above' },
    { type: 'belowAverage', hint: 'Below' },
];

const RULE_SUBMENUS = [
    { title: 'Highlight cell rules', rules: HIGHLIGHT_CELL_RULES },
    { title: 'Item selection rules', rules: ITEM_SELECTION_RULES },
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

const PRESET_SUBMENUS = [
    { title: 'Color scale', presets: COLOR_SCALE_PRESETS, apply: applyColorScalePreset },
    { title: 'Data bar', presets: DATA_BAR_PRESETS, apply: applyDataBarPreset },
];

// The colors of a color scale from the highest value's down, or a data bar's one color. A preset never repeats a color.
function PresetSwatch({ presetKey }: { presetKey: string }) {
    const colors = CF_PRESETS[presetKey] ?? [];
    return (
        <div className="flex w-12 h-4 rounded-sm overflow-hidden border border-border">
            {colors.map((color) => (
                <div key={color} className="flex-1" style={{ backgroundColor: color }} />
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
                {RULE_SUBMENUS.map(({ title, rules }) => (
                    <DropdownMenuSub key={title}>
                        <DropdownMenuSubTrigger>{title}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            {rules.map(({ type, hint }) => (
                                <DropdownMenuItem key={type} onClick={() => showDialog(<ConditionRules type={type} />)}>
                                    <div className="flex items-center justify-between w-full">
                                        <span>{RULE_COPY[type].label}</span>
                                        <span className="text-xs opacity-50 ml-4">{hint}</span>
                                    </div>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                ))}

                {PRESET_SUBMENUS.map(({ title, presets, apply }) => (
                    <DropdownMenuSub key={title}>
                        <DropdownMenuSubTrigger>{title}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="sheet-mousedown-cancel">
                            {presets.map(({ key, label }) => (
                                <DropdownMenuItem key={key} onClick={() => setContext((ctx) => apply(ctx, key))}>
                                    <PresetSwatch presetKey={key} />
                                    <span>{label}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                ))}

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
