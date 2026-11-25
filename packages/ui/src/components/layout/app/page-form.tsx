// The form of a page, such as Admin's Server settings or a contact's edit: its fields on FormShell's keys, focused on
// the first as it mounts. A draft page shows Reset and Save once something changed, and with nothing changed Enter does
// nothing; a page that edits one thing shows Cancel and its own label, such as Create, from the start. While the draft
// holds a change a LeaveGuard asks before the page is left, standing down while the save runs. A failed save keeps the
// draft for another try beside its hook's toast.

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
    children: ReactNode;
} & (
    | {
          // Puts the draft back to what was saved.
          onReset: () => void;
          onCancel?: never;
          submitLabel?: never;
      }
    | {
          // Leaves the page, through the leave guard like any other way out.
          onCancel: () => void;
          submitLabel: string;
          onReset?: never;
      }
);

export function PageForm({ onSubmit, changed, onReset, onCancel, submitLabel = 'Save', children }: PageFormProps) {
    const { pending, run } = useDialogPending();
    const showsFooter = changed || !onReset;

    return (
        <FormShell className="space-y-6" onSubmit={() => (showsFooter ? run(onSubmit) : undefined)} autoFocus>
            {children}
            {showsFooter && (
                <>
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={onReset ?? onCancel} disabled={pending}>
                            {onReset ? 'Reset' : 'Cancel'}
                        </Button>
                        <Button type="submit" pending={pending}>
                            {submitLabel}
                        </Button>
                    </div>
                </>
            )}
            <LeaveGuard active={changed} pending={pending} />
        </FormShell>
    );
}
