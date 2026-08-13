import { useState } from 'react';
import { Button } from '../button';
import { DeleteDialog } from './delete-dialog';

export type DangerZoneProps = {
    title?: string;
    description: string;
    buttonLabel: string;
    confirmTitle: string;
    confirmDescription: string;
    onConfirm: () => void | Promise<void>;
};

export function DangerZone({
    title = 'Danger zone',
    description,
    buttonLabel,
    confirmTitle,
    confirmDescription,
    onConfirm,
}: DangerZoneProps) {
    const [showConfirm, setShowConfirm] = useState(false);
    return (
        <div className="border-t pt-6">
            <h3 className="text-sm font-medium text-destructive mb-2">{title}</h3>
            <p className="text-sm text-muted-foreground mb-3">{description}</p>
            <Button variant="destructive" size="sm" onClick={() => setShowConfirm(true)}>
                {buttonLabel}
            </Button>
            <DeleteDialog
                open={showConfirm}
                onOpenChange={setShowConfirm}
                title={confirmTitle}
                description={confirmDescription}
                onDelete={onConfirm}
            />
        </div>
    );
}
