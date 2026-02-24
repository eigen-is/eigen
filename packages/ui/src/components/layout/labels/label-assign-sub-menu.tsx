import {Check, Minus, Tag} from 'lucide-react';
import {
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuItem,
} from '@workspace/ui/components/dropdown-menu';
import type {Label} from '@workspace/lib/types/label';

type LabelAssignSubMenuProps = {
    labels: Label[];
    assignedLabelIds: string[];
    partialLabelIds?: string[];
    onToggleLabel: (labelId: string) => void;
}

export function LabelAssignSubMenu({labels, assignedLabelIds, partialLabelIds = [], onToggleLabel}: LabelAssignSubMenuProps) {
    if (labels.length === 0) return null;

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Tag className="w-4 h-4 mr-2"/>
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
                                className="w-3 h-3 rounded-full mr-2 shrink-0"
                                style={{backgroundColor: label.color}}
                            />
                            <span className="flex-1">{label.name}</span>
                            {isAllAssigned && <Check className="w-4 h-4 ml-2 shrink-0"/>}
                            {isPartial && !isAllAssigned && <Minus className="w-4 h-4 ml-2 shrink-0"/>}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
