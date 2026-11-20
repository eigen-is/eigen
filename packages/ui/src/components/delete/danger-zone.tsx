// The red "Danger zone" at the foot of a detail page, such as an admin's user detail: a line on what the action does
// and a button that asks before it runs, in a destructive ConfirmDialog.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../button';
import { ConfirmDialog } from '../confirm-dialog';

export type DangerZoneProps = {
    description: string;
    buttonLabel: string;
    confirmTitle: string;
    confirmDescription: ReactNode;
    onConfirm: () => void | Promise<void>;
};

export function DangerZone({ description, buttonLabel, confirmTitle, confirmDescription, onConfirm }: DangerZoneProps) {
    const [showConfirm, setShowConfirm] = useState(false);
    return (
        <div className="border-t pt-6">
            <h3 className="text-sm font-medium text-destructive mb-2">Danger zone</h3>
            <p className="text-sm text-muted-foreground mb-3">{description}</p>
            <Button variant="destructive" size="sm" onClick={() => setShowConfirm(true)}>
                {buttonLabel}
            </Button>
            <ConfirmDialog
                open={showConfirm}
                onOpenChange={setShowConfirm}
                title={confirmTitle}
                description={confirmDescription}
                onConfirm={onConfirm}
                confirmText="Delete"
                destructive
            />
        </div>
    );
}
