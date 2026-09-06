import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { LightEditor } from '@workspace/ui/components/editor';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { useState } from 'react';

type OnboardingDraft = {
    openSignup?: boolean;
    waitlist?: Partial<ServerSettings['onboarding']['waitlist']>;
    autoAddOwnerContact?: boolean;
    welcomeMail?: Partial<ServerSettings['onboarding']['welcomeMail']>;
    inviteEmail?: Partial<ServerSettings['onboarding']['inviteEmail']>;
};

export function OnboardingSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();

    const [draft, setDraft] = useState<OnboardingDraft>({});
    const [dirty, setDirty] = useState(false);
    // LightEditor reads `content` once at init and ignores later prop changes. Bumping this
    // key remounts both editors so Reset re-seeds them from server state.
    const [editorKey, setEditorKey] = useState(0);

    if (isLoading || !settings) {
        return <LoadingState />;
    }

    const onboarding = settings.onboarding;

    const current = {
        openSignup: draft.openSignup ?? onboarding.openSignup,
        waitlist: { ...onboarding.waitlist, ...draft.waitlist },
        autoAddOwnerContact: draft.autoAddOwnerContact ?? onboarding.autoAddOwnerContact,
        welcomeMail: { ...onboarding.welcomeMail, ...draft.welcomeMail },
        inviteEmail: { ...onboarding.inviteEmail, ...draft.inviteEmail },
    };

    const update = (patch: OnboardingDraft) => {
        setDirty(true);
        setDraft((prev) => ({
            ...prev,
            ...patch,
            waitlist: patch.waitlist ? { ...prev.waitlist, ...patch.waitlist } : prev.waitlist,
            welcomeMail: patch.welcomeMail ? { ...prev.welcomeMail, ...patch.welcomeMail } : prev.welcomeMail,
            inviteEmail: patch.inviteEmail ? { ...prev.inviteEmail, ...patch.inviteEmail } : prev.inviteEmail,
        }));
    };

    const handleSave = async () => {
        await updateSettings.mutateAsync({ onboarding: draft });
        setDraft({});
        setDirty(false);
    };

    const handleReset = () => {
        setDraft({});
        setDirty(false);
        setEditorKey((k) => k + 1);
    };

    return (
        <div className="space-y-6">
            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Open signup</h3>
                <p className="text-sm text-muted-foreground">
                    When enabled, anyone can create an account through the public sign-up endpoint. Leave off to onboard
                    only through invites, the waitlist and admin user creation.
                </p>

                <div className="flex items-center gap-3">
                    <Switch checked={current.openSignup} onCheckedChange={(openSignup) => update({ openSignup })} />
                    <Label>Allow open account signup</Label>
                </div>
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Waitlist</h3>
                <p className="text-sm text-muted-foreground">
                    When enabled, the landing page shows a "Join Waitlist" form.
                </p>

                <div className="flex items-center gap-3">
                    <Switch
                        checked={current.waitlist.enabled}
                        onCheckedChange={(enabled) => update({ waitlist: { enabled } })}
                    />
                    <Label>Enable waitlist</Label>
                </div>
            </div>

            {current.waitlist.enabled && (
                <div className="space-y-4">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Invite Email</h3>
                    <p className="text-sm text-muted-foreground">
                        Email sent to waitlist members when their application is accepted.
                    </p>
                    <div className="space-y-1.5">
                        <Label>Subject</Label>
                        <Input
                            value={current.inviteEmail.subject}
                            onChange={(e) => update({ inviteEmail: { subject: e.target.value } })}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Body</Label>
                        <div className="border rounded-md p-3 min-h-[160px] bg-background">
                            <LightEditor
                                key={`invite-${editorKey}`}
                                content={current.inviteEmail.body}
                                onChange={(body) => update({ inviteEmail: { body } })}
                                toolbar="floating"
                                containerClassName="relative flex flex-col"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Available placeholders: {'{email}'}, {'{orgName}'}, {'{domain}'}, {'{inviteLink}'}
                        </p>
                    </div>
                </div>
            )}

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Auto-add admin contact
                </h3>
                <p className="text-sm text-muted-foreground">
                    Automatically add the organization owner as a contact for new users.
                </p>

                <div className="flex items-center gap-3">
                    <Switch
                        checked={current.autoAddOwnerContact}
                        onCheckedChange={(autoAddOwnerContact) => update({ autoAddOwnerContact })}
                    />
                    <Label>Add owner to new user contacts</Label>
                </div>
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Welcome mail</h3>
                <p className="text-sm text-muted-foreground">
                    Send a welcome email to new users when their account is created.
                </p>

                <div className="flex items-center gap-3">
                    <Switch
                        checked={current.welcomeMail.enabled}
                        onCheckedChange={(enabled) => update({ welcomeMail: { enabled } })}
                    />
                    <Label>Send welcome email</Label>
                </div>

                {current.welcomeMail.enabled && (
                    <>
                        <div className="space-y-1.5">
                            <Label>Subject</Label>
                            <Input
                                value={current.welcomeMail.subject}
                                onChange={(e) => update({ welcomeMail: { subject: e.target.value } })}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Body</Label>
                            <div className="border rounded-md p-3 min-h-[160px] bg-background">
                                <LightEditor
                                    key={`welcome-${editorKey}`}
                                    content={current.welcomeMail.body}
                                    onChange={(body) => update({ welcomeMail: { body } })}
                                    toolbar="floating"
                                    containerClassName="relative flex flex-col"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Available placeholders: {'{name}'}, {'{orgName}'}, {'{domain}'}
                            </p>
                        </div>
                    </>
                )}
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
