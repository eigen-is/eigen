import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { useState } from 'react';

type GuestDraft = Partial<ServerSettings['guests']>;

export function GuestSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const [draft, setDraft] = useState<GuestDraft>({});
    const [dirty, setDirty] = useState(false);

    if (isLoading || !settings) {
        return <LoadingState />;
    }

    const guests = settings.guests ?? { openSignup: true, inactivityDays: 7 };
    const current = {
        openSignup: draft.openSignup ?? guests.openSignup,
        inactivityDays: draft.inactivityDays ?? guests.inactivityDays,
    };

    const update = (patch: GuestDraft) => {
        setDirty(true);
        setDraft((prev) => ({ ...prev, ...patch }));
    };

    const handleSave = async () => {
        await updateSettings.mutateAsync({ guests: draft });
        setDraft({});
        setDirty(false);
    };

    const handleReset = () => {
        setDraft({});
        setDirty(false);
    };

    return (
        <div className="space-y-6">
            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Open signup</h3>
                <p className="text-sm text-muted-foreground">
                    When enabled, anyone can request a guest OTP — even if no resource has been shared with their email
                    yet. Disable to require a pending share before issuing OTPs.
                </p>

                <div className="flex items-center gap-3">
                    <Switch checked={current.openSignup} onCheckedChange={(openSignup) => update({ openSignup })} />
                    <Label>Allow open guest signup</Label>
                </div>
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Inactivity cleanup
                </h3>
                <p className="text-sm text-muted-foreground">
                    Guest accounts with no session activity for this many days are deleted automatically by a daily
                    sweep. Their share registry entries persist, so re-signing in restores their shared resources.
                </p>

                <div className="space-y-1.5">
                    <Label>Days of inactivity before deletion</Label>
                    <Input
                        type="number"
                        min={1}
                        max={365}
                        value={current.inactivityDays}
                        onChange={(e) => {
                            const value = e.target.valueAsNumber;
                            if (Number.isNaN(value) || value < 1) return;
                            update({ inactivityDays: value });
                        }}
                    />
                </div>
            </div>

            {dirty && (
                <>
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={handleReset}>
                            Reset
                        </Button>
                        <Button onClick={handleSave} disabled={updateSettings.isPending}>
                            {updateSettings.isPending ? 'Saving...' : 'Save'}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
