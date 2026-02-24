import {useState} from 'react';
import {Pencil, PlusIcon} from 'lucide-react';
import {cn} from "../../../lib/utils";
import {LabelDialog} from './label-dialog';
import {LabelManagerProps} from './types';
import {SidebarItem} from '../sidebar';
import {DroppableSidebarItem} from '../sidebar/droppable-sidebar-item';
import {TooltipButton} from "@workspace/ui";
import {useLabels} from './label-provider';
import type {Label} from "@workspace/lib/types/label";

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
    const {addLabel, updateLabel, deleteLabel} = useLabels();

    const handleAddLabel = () => {
        setSelectedLabel(null);
        setDialogOpen(true);
    };

    const handleEditClick = (label: Label) => {
        setSelectedLabel(label);
        setDialogOpen(true);
    };

    const handleSubmit = async (data: { name: string; color: string }) => {
        try {
            if (selectedLabel) {
                // Edit existing label
                await updateLabel({
                    ...selectedLabel,
                    name: data.name,
                    color: data.color,
                });
            } else {
                // Add new label
                await addLabel({
                    name: data.name,
                    color: data.color,
                });
            }
            setDialogOpen(false);
        } catch (error) {
            console.error('Error submitting label:', error);
            // Keep dialog open on error so user can try again
        }
    };

    const handleDeleteLabel = async () => {
        try {
            if (selectedLabel) {
                await deleteLabel(selectedLabel.id);
                setDialogOpen(false);
            }
        } catch (error) {
            console.error('Error deleting label:', error);
            // Keep dialog open on error so user can try again
        }
    };

    return (
        <div className={cn("py-2", className)}>
            <div className={cn(
                "flex items-center mb-2",
                condensed ? "justify-center" : "justify-between"
            )}>
                {!condensed && <h3 className="text-sm font-semibold text-foreground px-3 select-none">Labels</h3>}
                <div className="flex items-center gap-1">
                    <TooltipButton
                        icon={PlusIcon}
                        tooltipText="Add new label"
                        onClick={handleAddLabel}
                    />
                </div>
            </div>

            <div className="space-y-1">
                {labels.map((label) => {
                    const editButton = !condensed && (
                        <div className="editButton absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100">
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
                        className: !condensed ? "pr-8 relative group" : "",
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
            </div>

            <LabelDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                selectedLabel={selectedLabel}
                onSubmit={handleSubmit}
                onDelete={handleDeleteLabel}
            />
        </div>
    );
}
