// The header above a list filtered by one label, such as Contacts' label view: the label's color and name, and a
// pencil that opens LabelDialog to edit or delete it.

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
    const [dialogOpen, setDialogOpen] = useState(false);
    const { mutateAsync: updateLabel } = useUpdateLabel();
    const { mutateAsync: deleteLabel } = useDeleteLabel();

    const label = labels.find((l) => l.id === labelId);
    if (!label) return null;

    return (
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
                    onClick={() => setDialogOpen(true)}
                />
            </div>

            <LabelDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                selectedLabel={label}
                onSubmit={(data) => updateLabel({ ...label, name: data.name, color: data.color })}
                onDelete={async () => {
                    await deleteLabel(label.id);
                    setDialogOpen(false);
                }}
            />
        </>
    );
}
