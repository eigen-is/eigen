// The form of a draft page, such as Admin's Server settings: its fields on FormShell's keys, focused on the first as it
// mounts, with a Reset and Save footer that shows once something changed. Enter or Cmd+Enter saves, and with nothing
// changed does nothing. While the draft holds a change a LeaveGuard asks before the page is left, standing down while
// the save runs. A failed save keeps the draft for another try beside its hook's toast.

import { rethrowUntoasted } from '@workspace/lib/api-error';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { DialogAction } from '../../../hooks/use-dialog-pending';
import { Button } from '../../button';
import { FormShell } from '../../form-shell';
import { Separator } from '../../separator';
import { LeaveGuard } from './leave-guard';

type PageFormProps = {
    // Returns or resolves false when its check refused, such as a field marked invalid, which then gets the focus.
    onSubmit: DialogAction;
    changed: boolean;
    // Puts the draft back to what was saved.
    onReset: () => void;
    children: ReactNode;
};

export function PageForm({ onSubmit, changed, onReset, children }: PageFormProps) {
    const [pending, setPending] = useState(false);

    const submit = async () => {
        if (pending || !changed) return;
        setPending(true);
        try {
            if ((await onSubmit()) === false) return false;
        } catch (error) {
            rethrowUntoasted(error);
        } finally {
            setPending(false);
        }
    };

    return (
        <FormShell className="space-y-6" onSubmit={submit} autoFocus>
            {children}
            {changed && (
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
            )}
            <LeaveGuard active={changed && !pending} />
        </FormShell>
    );
}
