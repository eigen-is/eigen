import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { LoadingState, SettingsFooter, SettingsSection } from '@workspace/ui';
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

    const current = {
        openSignup: draft.openSignup ?? settings.guests.openSignup,
        inactivityDays: draft.inactivityDays ?? settings.guests.inactivityDays,
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
            <SettingsSection
                title="Open signup"
                description="When enabled, anyone can request a guest OTP — even if no resource has been shared with their email yet. Disable to require a pending share before issuing OTPs."
            >
                <div className="flex items-center gap-3">
                    <Switch checked={current.openSignup} onCheckedChange={(openSignup) => update({ openSignup })} />
                    <Label>Allow open guest signup</Label>
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Inactivity cleanup"
                description="Guest accounts with no session activity for this many days are deleted automatically by a daily sweep. Their share registry entries persist, so re-signing in restores their shared resources."
            >
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
            </SettingsSection>

            <SettingsFooter dirty={dirty} saving={updateSettings.isPending} onSave={handleSave} onReset={handleReset} />
        </div>
    );
}
