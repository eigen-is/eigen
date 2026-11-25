// The form of a settings page, such as Space's Change password or Admin's Server settings: its fields on FormShell's
// keys, focused on the first as it mounts, and its button below them. A draft page passes `onReset` and gets a Reset
// and Save footer that shows once something changed, where Enter with nothing changed does nothing. While the form
// holds a change a LeaveGuard asks before the page is left, standing down while the save runs, a save's own
// navigation included. A failed save keeps what was typed for another try beside its hook's toast.

import type { ReactNode } from 'react';
import type { DialogAction } from '../../../hooks/use-dialog-pending';
import { useDialogPending } from '../../../hooks/use-dialog-pending';
import { Button } from '../../button';
import { FormShell } from '../../form-shell';
import { Separator } from '../../separator';
import { LeaveGuard } from './leave-guard';

type PageFormProps = {
    // Returns or resolves false when its check refused, such as a field marked invalid, which then gets the focus.
    onSubmit: DialogAction;
    changed: boolean;
    submitLabel?: string;
    // Puts the draft back to what was saved.
    onReset?: () => void;
    children: ReactNode;
};

export function PageForm({ onSubmit, changed, submitLabel = 'Save', onReset, children }: PageFormProps) {
    const { pending, run } = useDialogPending();
    const submit = (
        <Button type="submit" pending={pending}>
            {submitLabel}
        </Button>
    );

    return (
        <FormShell className="space-y-6" onSubmit={() => (changed || !onReset ? run(onSubmit) : undefined)} autoFocus>
            {children}
            {!onReset && <div className="flex justify-end">{submit}</div>}
            {onReset && changed && (
                <>
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={onReset} disabled={pending}>
                            Reset
                        </Button>
                        {submit}
                    </div>
                </>
            )}
            <LeaveGuard active={changed} pending={pending} />
        </FormShell>
    );
}
