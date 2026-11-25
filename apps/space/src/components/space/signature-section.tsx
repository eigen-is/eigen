// The Signature section of Space's Mail settings: a rich-text editor for the user's email signature and its Save
// button, on FormShell's keys, with a LeaveGuard while a change is unsaved. Mail adds the signature to new emails and
// above the quote in replies and forwards. The editor opens on the saved signature once it has loaded, and takes no
// focus then, since the page has other sections.

import { useSaveSignature, useSpaceSettings } from '@workspace/lib/space';
import type { EmailSignature } from '@workspace/lib/types/settings';
import { Button } from '@workspace/ui/components/button';
import { LightEditor } from '@workspace/ui/components/editor';
import { FormShell } from '@workspace/ui/components/form-shell';
import { LeaveGuard, LoadingState } from '@workspace/ui/components/layout/app';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useId, useState } from 'react';

export function SignatureSection() {
    const { data, isLoading } = useSpaceSettings();
    if (isLoading) return <LoadingState />;
    return <SignatureForm existing={data?.email?.signatures?.[0]} />;
}

// The editor reads its content only as it mounts, so it mounts once the saved signature is known.
function SignatureForm({ existing }: { existing?: EmailSignature }) {
    const save = useSaveSignature();
    const { pending, run } = useDialogPending();
    const headingId = useId();
    const [html, setHtml] = useState(existing?.html ?? '');
    // A new signature's id is claimed once, so every save writes the same one.
    const [id] = useState(() => existing?.id ?? crypto.randomUUID());

    const isDirty = html !== (existing?.html ?? '');

    const handleSave = async () => {
        await save.mutateAsync({ id, name: existing?.name ?? 'Default', html });
    };

    return (
        <FormShell className="space-y-4" onSubmit={() => (isDirty ? run(handleSave) : undefined)}>
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
                <Button type="submit" pending={pending} disabled={!isDirty}>
                    Save
                </Button>
            </div>
            <LeaveGuard active={isDirty} pending={pending} />
        </FormShell>
    );
}
