import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { LightEditor } from '@workspace/ui/components/layout/editor';
import { useEffect, useRef, useState } from 'react';

export function SignatureSection() {
    const { data, isLoading } = useSpaceSettings();
    const update = useUpdateSpaceSettings();
    const existing = data?.email?.signatures?.[0];

    const [html, setHtml] = useState('');
    const seededRef = useRef<string | null>(null);

    // Seed the editor from server data once per signature id. Subsequent settings refetches
    // (e.g., after a save) keep the user's in-progress text — they only re-seed when the
    // identity of the signature changes (first load, or signature absent → present).
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
        update.mutate({
            email: {
                signatures: [
                    {
                        id: existing?.id ?? crypto.randomUUID(),
                        name: existing?.name ?? 'Default',
                        html,
                    },
                ],
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
