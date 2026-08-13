import { useDeleteLabel, useUpdateLabel } from '@workspace/lib/contacts';
import type { Label } from '@workspace/lib/types/label';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { LabelDialog } from './label-dialog';

export type LabelFilterHeaderProps = {
    labels: Label[];
    labelId: string;
};

export function LabelFilterHeader({ labels, labelId }: LabelFilterHeaderProps) {
    const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const { mutateAsync: updateLabel } = useUpdateLabel();
    const { mutateAsync: deleteLabel } = useDeleteLabel();

    const label = labels.find((l) => l.id === labelId);

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
        } catch {
            // Mutation's onError handles the toast; keep dialog open for retry
        }
    };

    const handleDeleteLabel = async () => {
        if (!selectedLabel) return;
        await deleteLabel(selectedLabel.id);
        setDialogOpen(false);
    };

    return label ? (
        <>
            <div className="flex items-center justify-between h-12 app-gutter-x border-b">
                <h1 className="text-base font-medium flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} />
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
