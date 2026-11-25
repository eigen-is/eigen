// The admin's Onboarding page: the landing page's waitlist, the email an accepted person gets with their invite,
// and what a new user starts with, such as a welcome mail. It edits the server settings as a draft on a PageForm and
// saves them together.

import { useMailEnabled } from '@workspace/lib/public';
import { useServerSettings, useUpdateServerSettings } from '@workspace/lib/settings';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { LightEditor } from '@workspace/ui/components/editor';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LoadingState, PageForm, SettingsSection } from '@workspace/ui/components/layout/app';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { useId, useState } from 'react';
import { usePageDraft } from './hooks/use-page-draft';

type OnboardingDraft = DeepPartial<ServerSettings['onboarding']>;

export function OnboardingSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();

    if (isLoading || !settings) {
        return <LoadingState />;
    }
    return <OnboardingSettingsForm onboarding={settings.onboarding} />;
}

// Mounted once the settings have loaded, so the draft starts from them.
function OnboardingSettingsForm({ onboarding }: { onboarding: ServerSettings['onboarding'] }) {
    const updateSettings = useUpdateServerSettings();
    const mailEnabled = useMailEnabled();

    const { draft, setDraft, current, changed, reset } = usePageDraft(onboarding, withDraft);
    // LightEditor reads `content` once, as it mounts, so Reset bumps this key to remount both editors on what was saved.
    const [editorKey, setEditorKey] = useState(0);
    const fieldId = useId();

    const update = (patch: OnboardingDraft) => {
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
        reset();
    };

    const handleReset = () => {
        reset();
        setEditorKey((k) => k + 1);
    };

    return (
        <PageForm changed={changed} onSubmit={handleSave} onReset={handleReset}>
            <SettingsSection
                title="Waitlist"
                description='When enabled, the landing page shows a "Join waitlist" form.'
            >
                <div className="flex items-center gap-3">
                    <Switch
                        id={`${fieldId}-waitlist`}
                        checked={current.waitlist.enabled}
                        onCheckedChange={(enabled) => update({ waitlist: { enabled } })}
                    />
                    <Label htmlFor={`${fieldId}-waitlist`}>Enable waitlist</Label>
                </div>
            </SettingsSection>

            {current.waitlist.enabled && (
                <SettingsSection
                    title="Invite email"
                    description="Email sent to waitlist members when their application is accepted."
                >
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-invite-subject`}>Subject</Label>
                        <Input
                            id={`${fieldId}-invite-subject`}
                            value={current.inviteEmail.subject}
                            onChange={(e) => update({ inviteEmail: { subject: e.target.value } })}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label id={`${fieldId}-invite-body`}>Body</Label>
                        <div className="border rounded-md p-3 min-h-[160px] bg-background">
                            <LightEditor
                                key={`invite-${editorKey}`}
                                labelledBy={`${fieldId}-invite-body`}
                                content={current.inviteEmail.body}
                                onChange={(body) => update({ inviteEmail: { body } })}
                                submitOnModEnter
                                toolbar="floating"
                                containerClassName="relative flex flex-col"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Available placeholders: {'{email}'}, {'{orgName}'}, {'{domain}'}, {'{inviteLink}'}
                        </p>
                    </div>
                </SettingsSection>
            )}

            <Separator />

            <SettingsSection
                title="Auto-add admin contact"
                description="Automatically add the organization owner as a contact for new users."
            >
                <div className="flex items-center gap-3">
                    <Switch
                        id={`${fieldId}-owner-contact`}
                        checked={current.autoAddOwnerContact}
                        onCheckedChange={(autoAddOwnerContact) => update({ autoAddOwnerContact })}
                    />
                    <Label htmlFor={`${fieldId}-owner-contact`}>Add owner to new user contacts</Label>
                </div>
            </SettingsSection>

            {/* Never sent without hosted mail, so there is nothing to set. */}
            {mailEnabled && (
                <>
                    <Separator />

                    <SettingsSection
                        title="Welcome mail"
                        description="Send a welcome email to new users when their account is created."
                    >
                        <div className="flex items-center gap-3">
                            <Switch
                                id={`${fieldId}-welcome`}
                                checked={current.welcomeMail.enabled}
                                onCheckedChange={(enabled) => update({ welcomeMail: { enabled } })}
                            />
                            <Label htmlFor={`${fieldId}-welcome`}>Send welcome email</Label>
                        </div>

                        {current.welcomeMail.enabled && (
                            <>
                                <div className="space-y-1.5">
                                    <Label htmlFor={`${fieldId}-welcome-subject`}>Subject</Label>
                                    <Input
                                        id={`${fieldId}-welcome-subject`}
                                        value={current.welcomeMail.subject}
                                        onChange={(e) => update({ welcomeMail: { subject: e.target.value } })}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label id={`${fieldId}-welcome-body`}>Body</Label>
                                    <div className="border rounded-md p-3 min-h-[160px] bg-background">
                                        <LightEditor
                                            key={`welcome-${editorKey}`}
                                            labelledBy={`${fieldId}-welcome-body`}
                                            content={current.welcomeMail.body}
                                            onChange={(body) => update({ welcomeMail: { body } })}
                                            submitOnModEnter
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
                    </SettingsSection>
                </>
            )}
        </PageForm>
    );
}

function withDraft(onboarding: ServerSettings['onboarding'], draft: OnboardingDraft): ServerSettings['onboarding'] {
    return {
        waitlist: { ...onboarding.waitlist, ...draft.waitlist },
        autoAddOwnerContact: draft.autoAddOwnerContact ?? onboarding.autoAddOwnerContact,
        welcomeMail: { ...onboarding.welcomeMail, ...draft.welcomeMail },
        inviteEmail: { ...onboarding.inviteEmail, ...draft.inviteEmail },
    };
}
