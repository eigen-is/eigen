// The Signature section of Space's Mail settings: a rich-text editor for the user's email signature and its Save
// button. Mail adds the signature to new emails and above the quote in replies and forwards. The editor loads the
// saved signature once and keeps what the user types through later refetches.

import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { Button } from '@workspace/ui/components/button';
import { LightEditor } from '@workspace/ui/components/editor';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { useEffect, useRef, useState } from 'react';

export function SignatureSection() {
    const { data, isLoading } = useSpaceSettings();
    const update = useUpdateSpaceSettings();
    const existing = data?.email?.signatures?.[0];

    const [html, setHtml] = useState('');
    const seededRef = useRef<string | null>(null);

    // Seed the editor once per signature, so a refetch after a save keeps what the user is typing.
    useEffect(() => {
        const id = existing?.id ?? null;
        if (id !== seededRef.current) {
            seededRef.current = id;
            setHtml(existing?.html ?? '');
        }
    }, [existing?.id, existing?.html]);

    if (isLoading) return <LoadingState />;

    const isDirty = html !== (existing?.html ?? '');

    const handleSave = () => {
        // Claim the id before the save, so the refetch that gives a new signature its id doesn't seed the editor
        // again and drop what is typed meanwhile.
        const id = existing?.id ?? crypto.randomUUID();
        seededRef.current = id;
        update.mutate({
            email: {
                signatures: [{ id, name: existing?.name ?? 'Default', html }],
            },
        });
    };

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-lg font-medium">Signature</h2>
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
                />
            </div>
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={!isDirty || update.isPending}>
                    {update.isPending ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </div>
    );
}
