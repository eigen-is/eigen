// The Signature section of Space's Mail settings: a rich-text editor for the user's email signature and its Save
// button, on FormShell's keys, with a LeaveGuard while a change is unsaved. Mail adds the signature to new emails and
// above the quote in replies and forwards. The editor opens on the saved signature once it has loaded, with the focus
// in it as the first field on the page. A failed load shows an error, since an empty editor would save over the
// signature.

import { useSaveSignature, useSpaceSettings } from '@workspace/lib/space';
import type { EmailSignature } from '@workspace/lib/types/settings';
import { Button } from '@workspace/ui/components/button';
import { LightEditor } from '@workspace/ui/components/editor';
import { FormShell } from '@workspace/ui/components/form-shell';
import { ErrorState, LeaveGuard, LoadingState } from '@workspace/ui/components/layout/app';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useId, useState } from 'react';

export function SignatureSection() {
    const { data, isError } = useSpaceSettings();
    // A new signature's id is claimed once, so every save writes the same one and its first save remounts nothing.
    const [newId] = useState(() => crypto.randomUUID());
    if (data) {
        const existing = data.email?.signatures?.[0];
        const id = existing?.id ?? newId;
        return <SignatureForm key={id} id={id} existing={existing} />;
    }
    return isError ? <ErrorState message="Failed to load your signature." /> : <LoadingState />;
}

// The editor reads its content only as it mounts, so it mounts once the saved signature is known, and again when
// another one arrives.
function SignatureForm({ id, existing }: { id: string; existing?: EmailSignature }) {
    const save = useSaveSignature();
    const { pending, run } = useDialogPending();
    const headingId = useId();
    const [html, setHtml] = useState(existing?.html ?? '');

    const isDirty = html !== (existing?.html ?? '');

    const handleSave = async () => {
        await save.mutateAsync({ id, name: existing?.name ?? 'Default', html });
    };

    return (
        <FormShell autoFocus className="space-y-4" onSubmit={() => (isDirty ? run(handleSave) : undefined)}>
            <div>
                <h2 id={headingId} className="text-lg font-medium">
                    Signature
                </h2>
                <p className="text-sm text-muted-foreground">
                    Added to the bottom of new emails and above the quoted content in replies and forwards.
                </p>
            </div>
            <div className="border rounded-md p-4 min-h-[200px] bg-background">
                <LightEditor
                    content={html}
                    onChange={setHtml}
                    toolbar="floating"
                    placeholder="Type your signature here..."
                    labelledBy={headingId}
                    submitOnModEnter
                />
            </div>
            <div className="flex justify-end">
                <Button type="submit" pending={pending}>
                    Save
                </Button>
            </div>
            <LeaveGuard active={isDirty} />
        </FormShell>
    );
}
