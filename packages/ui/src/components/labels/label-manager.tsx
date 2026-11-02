// The Labels section of a sidebar, such as Contacts': each label links to its filtered list and may take dropped
// items, and the + and pencil buttons open LabelDialog to add, edit or delete one.

import { useAddLabel, useDeleteLabel, useUpdateLabel } from '@workspace/lib/contacts';
import type { Label } from '@workspace/lib/types/label';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { SidebarItem } from '../layout/sidebar';
import { DroppableSidebarItem } from '../layout/sidebar/droppable-sidebar-item';
import { SidebarSection } from '../layout/sidebar/sidebar-section';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { LabelDialog } from './label-dialog';
import type { LabelManagerProps } from './types';

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

    const handleSubmit = (data: { name: string; color: string }) =>
        selectedLabel
            ? updateLabel({ ...selectedLabel, name: data.name, color: data.color })
            : addLabel({ name: data.name, color: data.color });

    const handleDeleteLabel = async () => {
        if (!selectedLabel) return;
        // Let a rejection propagate to the shared DeleteDialog so it stays open for retry; only close on
        // success. The mutation's onError already surfaced the toast.
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
                        <div className="editButton absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100 pointer-coarse:opacity-80">
                            <TooltipButton
                                icon={Pencil}
                                tooltipText={`Edit label`}
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
