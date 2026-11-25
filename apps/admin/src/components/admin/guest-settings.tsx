// The owner's Guest access settings: whether anyone may ask for a guest sign-in code, even with nothing shared to
// them yet, and after how many idle days a guest account is deleted. Changes collect in a draft on a PageForm and save
// together through the server-settings hooks. The Guest access route shows it.

import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LoadingState, PageForm, SettingsSection } from '@workspace/ui/components/layout/app';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { useId, useState } from 'react';

type GuestDraft = Partial<ServerSettings['guests']>;

export function GuestSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const [draft, setDraft] = useState<GuestDraft>({});
    const fieldId = useId();

    if (isLoading || !settings) {
        return <LoadingState />;
    }

    const current = {
        openSignup: draft.openSignup ?? settings.guests.openSignup,
        inactivityDays: draft.inactivityDays ?? settings.guests.inactivityDays,
    };

    const changed =
        current.openSignup !== settings.guests.openSignup || current.inactivityDays !== settings.guests.inactivityDays;

    const update = (patch: GuestDraft) => setDraft((prev) => ({ ...prev, ...patch }));

    const handleSave = async () => {
        await updateSettings.mutateAsync({ guests: draft });
        setDraft({});
    };

    return (
        <PageForm changed={changed} onSubmit={handleSave} onReset={() => setDraft({})}>
            <SettingsSection
                title="Open signup"
                description="When enabled, anyone can request a guest OTP — even if no resource has been shared with their email yet. Disable to require a pending share before issuing OTPs."
            >
                <div className="flex items-center gap-3">
                    <Switch
                        id={`${fieldId}-open-signup`}
                        checked={current.openSignup}
                        onCheckedChange={(openSignup) => update({ openSignup })}
                    />
                    <Label htmlFor={`${fieldId}-open-signup`}>Allow open guest signup</Label>
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Inactivity cleanup"
                description="Guest accounts with no session activity for this many days are deleted automatically by a daily sweep. Their share registry entries persist, so re-signing in restores their shared resources."
            >
                <div className="space-y-1.5">
                    <Label htmlFor={`${fieldId}-days`}>Days of inactivity before deletion</Label>
                    <Input
                        id={`${fieldId}-days`}
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
        </PageForm>
    );
}
