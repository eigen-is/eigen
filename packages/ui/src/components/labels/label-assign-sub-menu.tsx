import type { Label } from '@workspace/lib/types/label';
import {
    DropdownMenuCheckboxItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Tag } from 'lucide-react';

type LabelAssignSubMenuProps = {
    labels: Label[];
    assignedLabelIds: string[];
    partialLabelIds?: string[];
    onToggleLabel: (labelId: string) => void;
};

export function LabelAssignSubMenu({
    labels,
    assignedLabelIds,
    partialLabelIds = [],
    onToggleLabel,
}: LabelAssignSubMenuProps) {
    if (labels.length === 0) return null;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Tag className="h-4 w-4" />
                Assign label
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {labels.map((label) => (
                    <DropdownMenuCheckboxItem
                        key={label.id}
                        checked={
                            assignedLabelIds.includes(label.id)
                                ? true
                                : partialLabelIds.includes(label.id)
                                  ? 'indeterminate'
                                  : false
                        }
                        // Stay open: labels are a multi-toggle.
                        onSelect={(e) => e.preventDefault()}
                        onCheckedChange={() => onToggleLabel(label.id)}
                    >
                        <span className="size-4 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                        {label.name}
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
