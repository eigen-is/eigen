// A properties panel's checkbox row, such as a chart axis's Show axis. A row that reads several objects at once passes
// MIXED when they disagree, and the box shows a minus; a click then turns them all on.

import { Checkbox } from '@workspace/ui/components/checkbox';
import type { MIXED } from './merged-value';
import { isMixed } from './merged-value';

type PropertyCheckboxProps = {
    label: string;
    checked: boolean | typeof MIXED;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    // For a label that reads only inside its section, e.g. "Horizontal axis: Show axis".
    'aria-label'?: string;
};

// A box with its label beside it, across the row: a box's label says what it turns on, so it runs longer
// than PropertyRow's label column holds.
export function PropertyCheckbox({
    label,
    checked,
    onCheckedChange,
    disabled,
    'aria-label': ariaLabel,
}: PropertyCheckboxProps) {
    return (
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none has-disabled:cursor-default">
            <Checkbox
                aria-label={ariaLabel}
                checked={isMixed(checked) ? 'indeterminate' : checked}
                disabled={disabled}
                onCheckedChange={(next) => onCheckedChange(next === true)}
            />
            {label}
        </label>
    );
}
