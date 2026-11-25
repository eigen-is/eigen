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
import { useId } from 'react';
import { usePageDraft } from './hooks/use-page-draft';

export function GuestSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();

    if (isLoading || !settings) {
        return <LoadingState />;
    }
    return <GuestSettingsForm guests={settings.guests} />;
}

// Mounted once the settings have loaded, so the draft starts from them.
function GuestSettingsForm({ guests }: { guests: ServerSettings['guests'] }) {
    const updateSettings = useUpdateServerSettings();
    const { draft, setDraft, current, changed, reset } = usePageDraft(guests, (loaded, patch) => ({
        ...loaded,
        ...patch,
    }));
    const fieldId = useId();

    const update = (patch: Partial<ServerSettings['guests']>) => setDraft((prev) => ({ ...prev, ...patch }));

    const handleSave = async () => {
        await updateSettings.mutateAsync({ guests: draft });
        reset();
    };

    return (
        <PageForm changed={changed} onSubmit={handleSave} onReset={reset}>
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
