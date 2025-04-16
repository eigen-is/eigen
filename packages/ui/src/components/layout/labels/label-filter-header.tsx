import {useRef, useState} from 'react';
import {Pencil} from 'lucide-react';
import {Label} from '@apps/api-server/types/label';
import {TooltipButton} from '@workspace/ui';
import {LabelDialog} from './label-dialog';

export interface LabelFilterHeaderProps {
    labels: Label[];
    labelId: string;
    onEditLabel?: (label: Label) => void;
    onDeleteLabel?: (labelId: string) => void;
}

export function LabelFilterHeader({
                                      labels,
                                      labelId,
                                      onEditLabel,
                                      onDeleteLabel,
                                  }: LabelFilterHeaderProps) {
    const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    
    const label = labels.find(l => l.id === labelId);
    
    const handleEditClick = (label: Label) => {
        setSelectedLabel(label);
        setDialogOpen(true);
    };
    
    const handleSubmit = (data: { name: string; color: string }) => {
        if (selectedLabel && onEditLabel) {
            // Edit existing label
            onEditLabel({
                ...selectedLabel,
                name: data.name,
                color: data.color,
            });
        }
        setDialogOpen(false);
    };
    
    const handleDeleteLabel = () => {
        if (selectedLabel && onDeleteLabel) {
            onDeleteLabel(selectedLabel.id);
            setDialogOpen(false);
        }
    };

    return label ? (
        <>
            <div className="h-12 px-4 flex items-center justify-between border-b">
                <h1 className="text-base font-medium flex items-center gap-2">
                    <span
                        className="h-3 w-3 rounded-full"
                        style={{backgroundColor: label.color}}
                    />
                    {label.name}
                </h1>
                {onEditLabel && (
                    <TooltipButton
                        icon={Pencil}
                        tooltipText="Edit label"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => handleEditClick(label)}
                    />
                )}
            </div>
            
            {onEditLabel && (
                <LabelDialog
                    open={dialogOpen}
                    onOpenChange={setDialogOpen}
                    selectedLabel={selectedLabel}
                    onSubmit={handleSubmit}
                    onDelete={handleDeleteLabel}
                />
            )}
        </>
    ) : null;
}