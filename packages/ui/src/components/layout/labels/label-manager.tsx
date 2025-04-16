import {useRef, useState} from 'react';
import {Pencil, PlusIcon, TagIcon} from 'lucide-react';
import {cn} from "../../../lib/utils";
import {LabelDialog} from './label-dialog';
import {LabelManagerProps} from './types';
import {SidebarItem} from '../sidebar';
import {TooltipButton} from "@workspace/ui";
import type {Label} from "@apps/api-server/types/label";

export function LabelManager({
                                 labels,
                                 onAddLabel,
                                 onEditLabel,
                                 onDeleteLabel,
                                 getLabelPath = (label) => `/label/${label.id.toLowerCase()}`,
                                 className,
                                 condensed = false,
                             }: LabelManagerProps) {
    const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const labelManagerRef = useRef<HTMLDivElement>(null);

    const handleAddLabel = () => {
        setSelectedLabel(null);
        setDialogOpen(true);
    };

    const handleEditClick = (label: Label) => {
        setSelectedLabel(label);
        setDialogOpen(true);
    };

    const handleSubmit = (data: { name: string; color: string }) => {
        if (selectedLabel) {
            // Edit existing label
            onEditLabel({
                ...selectedLabel,
                name: data.name,
                color: data.color,
            });
        } else {
            // Add new label
            onAddLabel({
                name: data.name,
                color: data.color,
            });
        }
        setDialogOpen(false);
    };

    const handleDeleteLabel = () => {
        if (selectedLabel) {
            onDeleteLabel(selectedLabel.id);
            setDialogOpen(false);
        }
    };

    return (
        <div className={cn("py-2", className)} ref={labelManagerRef}>
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
                {labels.map((label) => (
                    <SidebarItem
                        key={label.id}
                        icon={<></>}
                        label={label.name}
                        colorDot={label.color}
                        to={getLabelPath(label)}
                        condensed={condensed}
                        className={!condensed ? "pr-8 relative group" : ""}
                    >
                        {!condensed && (
                            <div className="editButton absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100">
                                <TooltipButton
                                    icon={Pencil}
                                    tooltipText={`Edit label`}
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleEditClick(label)}
                                />
                            </div>
                        )}
                    </SidebarItem>
                ))}
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
