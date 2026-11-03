// The Labels section of a sidebar, such as Contacts': each label links to its filtered list and may take dropped
// items, and the + and pencil buttons open LabelDialog to add, edit or delete one.

import { useAddLabel, useDeleteLabel, useUpdateLabel } from '@workspace/lib/contacts';
import type { Label } from '@workspace/lib/types/label';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { SidebarItem } from '../layout/sidebar';
import { DroppableSidebarItem } from '../layout/sidebar/droppable-sidebar-item';
import { SidebarSection } from '../layout/sidebar/sidebar-section';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import type { LabelFormValues } from './label-dialog';
import { LabelDialog } from './label-dialog';
import type { LabelManagerProps } from './types';

// HOVER_REVEAL_CLASS with the pencil's softer look: 80% on the row's hover and for the keyboard, 100% under the pointer.
// cn lets these opacities replace the 100% ones in HOVER_REVEAL_CLASS.
const PENCIL_REVEAL_CLASS = cn(
    HOVER_REVEAL_CLASS,
    'group-hover:opacity-80 group-has-focus-visible:opacity-80 pointer-coarse:opacity-80 hover:opacity-100',
);

export function LabelManager({
    labels,
    getLabelPath = (label) => `/label/${label.id.toLowerCase()}`,
    className,
    condensed = false,
    dropAcceptTypes,
    onItemDrop,
}: LabelManagerProps) {
    const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const { mutateAsync: addLabel } = useAddLabel();
    const { mutateAsync: updateLabel } = useUpdateLabel();
    const { mutateAsync: deleteLabel } = useDeleteLabel();

    const handleAddLabel = () => {
        setSelectedLabel(null);
        setDialogOpen(true);
    };

    const handleEditClick = (label: Label) => {
        setSelectedLabel(label);
        setDialogOpen(true);
    };

    const handleSubmit = (data: LabelFormValues) =>
        selectedLabel ? updateLabel({ ...selectedLabel, ...data }) : addLabel(data);

    const handleDeleteLabel = async () => {
        if (!selectedLabel) return;
        // A rejection keeps the DeleteDialog open for another try.
        await deleteLabel(selectedLabel.id);
        setDialogOpen(false);
    };

    return (
        <>
            <SidebarSection
                condensed={condensed}
                className={className}
                title="Labels"
                action={<TooltipButton icon={Plus} tooltipText="Add new label" onClick={handleAddLabel} />}
            >
                {labels.map((label) => {
                    const editButton = !condensed && (
                        <div className={cn('editButton absolute right-2', PENCIL_REVEAL_CLASS)}>
                            <TooltipButton
                                icon={Pencil}
                                tooltipText="Edit label"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditClick(label)}
                            />
                        </div>
                    );
                    const itemProps = {
                        icon: <></>,
                        label: label.name,
                        colorDot: label.color,
                        to: getLabelPath(label),
                        condensed,
                        className: !condensed ? 'pr-8 relative group' : '',
                    };

                    if (dropAcceptTypes && onItemDrop) {
                        return (
                            <DroppableSidebarItem
                                key={label.id}
                                acceptTypes={dropAcceptTypes}
                                onDrop={(data) => onItemDrop(data.ids, label.id)}
                                {...itemProps}
                            >
                                {editButton}
                            </DroppableSidebarItem>
                        );
                    }

                    return (
                        <SidebarItem key={label.id} {...itemProps}>
                            {editButton}
                        </SidebarItem>
                    );
                })}
            </SidebarSection>

            <LabelDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                selectedLabel={selectedLabel}
                onSubmit={handleSubmit}
                onDelete={handleDeleteLabel}
                labelCount={labels.length}
            />
        </>
    );
}
