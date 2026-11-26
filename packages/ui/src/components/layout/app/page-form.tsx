// The form of a page, such as Admin's Server settings or a contact's edit, on FormShell's keys and focused on its first
// field as it mounts. A draft page passes `onReset` and shows Reset and Save once something changed; any other names
// its submit, such as Create, shows it from the start and leaves to the caller what a Save with nothing changed means.
// While the form holds a change, a save that runs included, a LeaveGuard asks before the page is left, so the save's
// own navigation and Cancel's pass ignoreBlocker.

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
          // Drops the draft without asking, as Cancel does everywhere: a navigation here passes ignoreBlocker.
          onCancel?: () => void;
          submitLabel: string;
          onReset?: never;
      }
);

export function PageForm({ onSubmit, changed, onReset, onCancel, submitLabel = 'Save', children }: PageFormProps) {
    const { pending, run } = useDialogPending();
    const showsFooter = changed || !onReset;
    const back = onReset ?? onCancel;

    return (
        <FormShell className="space-y-6" onSubmit={() => (showsFooter ? run(onSubmit) : undefined)} autoFocus>
            {children}
            {showsFooter && (
                <>
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        {back && (
                            <Button variant="outline" onClick={back} disabled={pending}>
                                {onReset ? 'Reset' : 'Cancel'}
                            </Button>
                        )}
                        <Button type="submit" pending={pending}>
                            {submitLabel}
                        </Button>
                    </div>
                </>
            )}
            <LeaveGuard active={changed} />
        </FormShell>
    );
}
