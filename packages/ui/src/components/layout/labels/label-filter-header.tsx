import {useState} from 'react';
import {Pencil} from 'lucide-react';
import {Label} from '@apps/api-server/types/label';
import {TooltipButton} from '@workspace/ui';
import {LabelDialog} from './label-dialog';
import {useLabels} from './label-provider';

export interface LabelFilterHeaderProps {
    labels: Label[];
    labelId: string;
}

export function LabelFilterHeader({
                                      labels,
                                      labelId,
                                  }: LabelFilterHeaderProps) {
    const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const {updateLabel, deleteLabel} = useLabels();
    
    const label = labels.find(l => l.id === labelId);
    
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
            }
            setDialogOpen(false);
        } catch (error) {
            console.error('Error updating label:', error);
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
                <TooltipButton
                    icon={Pencil}
                    tooltipText="Edit label"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => handleEditClick(label)}
                />
            </div>
            
            <LabelDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                selectedLabel={selectedLabel}
                onSubmit={handleSubmit}
                onDelete={handleDeleteLabel}
            />
        </>
    ) : null;
}