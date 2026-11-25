// The form of a draft page, such as Admin's Server settings: its fields on FormShell's keys, focused on the first as it
// mounts, with a Reset and Save footer that shows once something changed. Enter or Cmd+Enter saves, and with nothing
// changed does nothing. An edit opened from a view, such as a team's settings, has Cancel and Save instead, throughout,
// and with nothing changed Save goes back like Cancel. While the draft holds a change a LeaveGuard asks before the page
// is left, standing down while the save runs. A failed save keeps the draft for another try beside its hook's toast.

import type { ReactNode } from 'react';
import type { DialogAction } from '../../../hooks/use-dialog-pending';
import { useDialogPending } from '../../../hooks/use-dialog-pending';
import { Button } from '../../button';
import { FormFooter } from '../../form-dialog';
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
      }
    | {
          // Goes back to the view the edit opened from.
          onCancel: () => void;
          onReset?: never;
      }
);

export function PageForm({ onSubmit, changed, onReset, onCancel, children }: PageFormProps) {
    const { pending, run } = useDialogPending();

    return (
        <FormShell className="space-y-6" onSubmit={() => (changed ? run(onSubmit) : onCancel?.())} autoFocus>
            {children}
            {onCancel ? (
                <FormFooter pending={pending} onCancel={onCancel} submitLabel="Save" />
            ) : (
                changed && (
                    <>
                        <Separator />
                        <div className="flex items-center justify-end gap-2">
                            <Button variant="outline" onClick={onReset} disabled={pending}>
                                Reset
                            </Button>
                            <Button type="submit" pending={pending}>
                                Save
                            </Button>
                        </div>
                    </>
                )
            )}
            <LeaveGuard active={changed} pending={pending} />
        </FormShell>
    );
}
