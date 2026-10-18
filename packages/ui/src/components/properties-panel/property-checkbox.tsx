import { Checkbox } from '@workspace/ui/components/checkbox';

type PropertyCheckboxProps = {
    label: string;
    checked: boolean;
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
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onCheckedChange(next === true)}
            />
            {label}
        </label>
    );
}
