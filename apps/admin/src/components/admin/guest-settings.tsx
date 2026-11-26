// The owner's Guest access settings, who from outside gets in: whether anyone may ask for a guest sign-in code, even
// with nothing shared to them yet, whether members may share an item with anyone who has its link, and after how many
// idle days a guest account is deleted. Changes collect in a draft on a PageForm and save together through the
// server-settings hooks, once the days are a whole number in the range the server takes. The Guest access route
// shows it.

import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { FieldError } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LoadingState, PageForm, SettingsSection } from '@workspace/ui/components/layout/app';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { useId } from 'react';
import { usePageDraft } from './hooks/use-page-draft';

// What the server takes.
const MIN_DAYS = 1;
const MAX_DAYS = 365;

export function GuestSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();

    if (isLoading || !settings) {
        return <LoadingState />;
    }
    return <GuestSettingsForm guests={settings.guests} sharing={settings.sharing} />;
}

type GuestAccessSettings = Pick<ServerSettings, 'guests' | 'sharing'>;

// Mounted once the settings have loaded, so the draft starts from them.
function GuestSettingsForm(loaded: GuestAccessSettings) {
    const updateSettings = useUpdateServerSettings();
    const { draft, setDraft, current, changed, reset } = usePageDraft(loaded, (settings, patch) => ({
        guests: { ...settings.guests, ...patch.guests },
        sharing: { ...settings.sharing, ...patch.sharing },
    }));
    const fieldId = useId();

    const update = (patch: Partial<ServerSettings['guests']>) =>
        setDraft((prev) => ({ ...prev, guests: { ...prev.guests, ...patch } }));
    const days = current.guests.inactivityDays;
    // An emptied field reads as NaN, which is no whole number either.
    const daysOutOfRange = !Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS;

    const handleSave = async () => {
        if (daysOutOfRange) return false;
        await updateSettings.mutateAsync(draft);
        reset();
    };

    return (
        <PageForm changed={changed} onSubmit={handleSave} onReset={reset}>
            <SettingsSection
                title="Open signup"
                description="On, anyone can ask for a sign-in code with their email address, even before anything is shared with them. Off, only someone who has something shared with them gets a code."
            >
                <div className="flex items-center gap-3">
                    <Switch
                        id={`${fieldId}-open-signup`}
                        checked={current.guests.openSignup}
                        onCheckedChange={(openSignup) => update({ openSignup })}
                    />
                    <Label htmlFor={`${fieldId}-open-signup`}>Allow open guest signup</Label>
                </div>
                <div className="space-y-1.5">
                    <div className="flex items-center gap-3">
                        <Switch
                            id={`${fieldId}-public-links`}
                            aria-describedby={`${fieldId}-public-links-description`}
                            checked={current.sharing.publicLinks}
                            onCheckedChange={(publicLinks) =>
                                setDraft((prev) => ({ ...prev, sharing: { publicLinks } }))
                            }
                        />
                        <Label htmlFor={`${fieldId}-public-links`}>Allow public links</Label>
                    </div>
                    <p id={`${fieldId}-public-links-description`} className="pl-11 text-xs text-muted-foreground">
                        Members can share a file, folder or document with anyone who has its link. No account needed.
                    </p>
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Inactivity cleanup"
                description="Once a day, guest accounts that have not been active for this many days are deleted. What was shared with them stays, so a guest who signs in again gets it back."
            >
                <div className="space-y-1.5">
                    <Label htmlFor={`${fieldId}-days`}>Days of inactivity before deletion</Label>
                    <Input
                        id={`${fieldId}-days`}
                        type="number"
                        min={MIN_DAYS}
                        max={MAX_DAYS}
                        value={Number.isNaN(days) ? '' : days}
                        onChange={(e) => update({ inactivityDays: e.target.valueAsNumber })}
                        aria-invalid={daysOutOfRange || undefined}
                        aria-describedby={daysOutOfRange ? `${fieldId}-days-error` : undefined}
                    />
                    {daysOutOfRange && (
                        <FieldError id={`${fieldId}-days-error`}>
                            A whole number of days, from {MIN_DAYS} to {MAX_DAYS}
                        </FieldError>
                    )}
                </div>
            </SettingsSection>
        </PageForm>
    );
}
