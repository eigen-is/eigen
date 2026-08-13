import type { Label } from '@workspace/lib/types/label';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Check, Minus, Tag } from 'lucide-react';

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
                <Tag className="h-4 w-4 mr-2" />
                Assign label
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {labels.map((label) => {
                    const isAllAssigned = assignedLabelIds.includes(label.id);
                    const isPartial = partialLabelIds.includes(label.id);
                    return (
                        <DropdownMenuItem
                            key={label.id}
                            onClick={(e) => {
                                e.preventDefault();
                                onToggleLabel(label.id);
                            }}
                        >
                            <span
                                className="h-3 w-3 rounded-full mr-2 shrink-0"
                                style={{ backgroundColor: label.color }}
                            />
                            <span className="flex-1">{label.name}</span>
                            {isAllAssigned && <Check className="h-4 w-4 ml-2 shrink-0" />}
                            {isPartial && !isAllAssigned && <Minus className="h-4 w-4 ml-2 shrink-0" />}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
