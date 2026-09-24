import { defaultSenderAddress } from '@workspace/lib/constants/mail';
import { useHomeDataLabel, useMailEnabled, usePublicConfig } from '@workspace/lib/public';
import {
    useCheckS3Connection,
    useHardenS3Bucket,
    useSendTestMail,
    useServerS3Config,
    useServerSettings,
    useUpdateOrgName,
    useUpdateServerS3Config,
    useUpdateServerSettings,
} from '@workspace/lib/settings';
import { EMPTY_S3, isS3ConfigValid } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { LandingLink, ServerSettings, ServerStorageType } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { validateEmailAddress } from '@workspace/lib/validation';
import { LoadingState, SettingsFooter, SettingsSection, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ServerStatusSection } from './server-status-section';
import { StorageTypePicker } from './storage-type-picker';

type EmailFlag = keyof ServerSettings['notifications']['email'];

export function ServerSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const { data: s3Config } = useServerS3Config();
    const updateS3Config = useUpdateServerS3Config();
    const s3Check = useCheckS3Connection();
    const s3Harden = useHardenS3Bucket();
    const homeDataLabel = useHomeDataLabel();
    const { data: config } = usePublicConfig();
    const mailEnabled = useMailEnabled();
    const updateOrgName = useUpdateOrgName();
    const sendTestMail = useSendTestMail();

    const [draft, setDraft] = useState<DeepPartial<ServerSettings>>({});
    const [dirty, setDirty] = useState(false);
    const [s3Draft, setS3Draft] = useState<S3Config | null>(null);
    const [s3Dirty, setS3Dirty] = useState(false);
    const [orgNameDraft, setOrgNameDraft] = useState<string | null>(null);

    if (isLoading || !settings || !config) {
        return <LoadingState />;
    }

    const orgName = orgNameDraft ?? config.orgName;
    const current = {
        mail: { ...settings.mail, ...draft.mail },
        quotas: { ...settings.quotas, ...draft.quotas },
        defaults: {
            mount: { ...settings.defaults.mount, ...draft.defaults?.mount },
        },
        notifications: {
            email: { ...settings.notifications.email, ...draft.notifications?.email },
        },
        landing: {
            links: draft.landing?.links ?? settings.landing?.links ?? [],
        },
    };

    const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
        if (Number.isNaN(value) || value < 0) return;
        setDirty(true);
        setDraft((prev) => ({ ...prev, quotas: { ...prev.quotas, [key]: value } }));
    };

    const updateEmailFlag = (key: EmailFlag, value: boolean) => {
        setDirty(true);
        setDraft((prev) => ({
            ...prev,
            notifications: { email: { ...prev.notifications?.email, [key]: value } },
        }));
    };

    const updateMail = (patch: Partial<ServerSettings['mail']>) => {
        setDirty(true);
        setDraft((prev) => ({ ...prev, mail: { ...prev.mail, ...patch } }));
    };

    const updateLinks = (links: LandingLink[]) => {
        setDirty(true);
        setDraft((prev) => ({ ...prev, landing: { links } }));
    };

    const patchLink = (index: number, patch: Partial<LandingLink>) =>
        updateLinks(current.landing.links.map((link, i) => (i === index ? { ...link, ...patch } : link)));

    const currentS3 = s3Draft ?? s3Config ?? EMPTY_S3;
    const anyDirty = dirty || s3Dirty || orgNameDraft !== null;
    const saving = updateSettings.isPending || updateS3Config.isPending || updateOrgName.isPending;
    // The test mail goes out from the saved sender, so an unsaved one would test the wrong thing.
    const senderDirty = draft.mail !== undefined || orgNameDraft !== null;
    const senderAddressInvalid = current.mail.senderAddress !== '' && !validateEmailAddress(current.mail.senderAddress);
    const handleS3Check = (config: S3Config) => s3Check.mutateAsync(config);
    const handleS3Harden = (config: S3Config, noncurrentDays: number) =>
        s3Harden.mutateAsync({ ...config, noncurrentDays });

    const handleSave = async () => {
        if (orgNameDraft !== null) await updateOrgName.mutateAsync(orgNameDraft.trim());
        if (s3Dirty && s3Draft && current.defaults.mount.storageType === 's3')
            await updateS3Config.mutateAsync(s3Draft);
        if (dirty)
            await updateSettings.mutateAsync(
                draft.landing ? { ...draft, landing: { links: normalizeLinks(draft.landing.links ?? []) } } : draft,
            );
        handleReset();
    };

    const handleReset = () => {
        setDraft({});
        setDirty(false);
        setS3Draft(null);
        setS3Dirty(false);
        setOrgNameDraft(null);
    };

    return (
        <div className="space-y-6">
            <SettingsSection title="General">
                <div className="space-y-1.5">
                    <Label>Organization name</Label>
                    <Input maxLength={100} value={orgName} onChange={(e) => setOrgNameDraft(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>Web address</Label>
                        <Input value={config.domain} disabled />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Mail domain</Label>
                        <Input value={config.mailDomain} disabled />
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">
                    The web address and mail domain are set at first setup; changing them would lock every user out.
                </p>
            </SettingsSection>

            <Separator />

            <ServerStatusSection />

            <SettingsSection
                title="Mail"
                description="The sender of the notifications, codes and invitations this server sends. Leave a field empty for the default shown."
            >
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>Sender name</Label>
                        <Input
                            maxLength={100}
                            placeholder={orgName}
                            value={current.mail.senderName}
                            onChange={(e) => updateMail({ senderName: e.target.value })}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Sender address</Label>
                        <Input
                            type="email"
                            placeholder={defaultSenderAddress(config.mailDomain)}
                            value={current.mail.senderAddress}
                            onChange={(e) => updateMail({ senderAddress: e.target.value.trim() })}
                        />
                        {senderAddressInvalid && (
                            <p className="text-xs text-destructive">This is not an email address</p>
                        )}
                    </div>
                </div>
                {!mailEnabled && (
                    <SwitchRow
                        label="Relay sends as users"
                        description={`Your relay allows sending from any address at ${config.mailDomain}. Off, mail on a user's behalf goes out as 'Name via ${orgName}' from the sender address.`}
                        checked={current.mail.relaySendsAsUsers}
                        onChange={(relaySendsAsUsers) => updateMail({ relaySendsAsUsers })}
                    />
                )}
                <div className="flex items-center gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sendTestMail.mutate()}
                        disabled={sendTestMail.isPending || senderDirty}
                    >
                        {sendTestMail.isPending ? 'Sending...' : 'Send test mail'}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        {senderDirty ? 'Save first: the test uses the saved sender.' : 'Sends one mail to you.'}
                    </p>
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection title="Storage Quotas">
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>{homeDataLabel} (MB)</Label>
                        <Input
                            type="number"
                            min={10}
                            value={current.quotas.mailAndContactsMaxMB}
                            onChange={(e) => updateQuota('mailAndContactsMaxMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Default Mount (MB)</Label>
                        <Input
                            type="number"
                            min={10}
                            value={current.quotas.defaultMountMaxSizeMB}
                            onChange={(e) => updateQuota('defaultMountMaxSizeMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Max Upload (MB)</Label>
                        <Input
                            type="number"
                            min={1}
                            value={current.quotas.maxUploadSizeMB}
                            onChange={(e) => updateQuota('maxUploadSizeMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Trash Retention (days)</Label>
                        <Input
                            type="number"
                            min={1}
                            value={current.quotas.trashRetentionDays}
                            onChange={(e) => updateQuota('trashRetentionDays', e.target.valueAsNumber)}
                        />
                    </div>
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Defaults"
                description="The storage type used for user Drives. Changing this only affects new users: existing users will not be migrated to the newly selected storage type."
            >
                <StorageTypePicker
                    storageType={current.defaults.mount.storageType}
                    onStorageTypeChange={(type: ServerStorageType) => {
                        setDirty(true);
                        setDraft((prev) => ({ ...prev, defaults: { mount: { storageType: type } } }));
                    }}
                    s3Config={currentS3}
                    onS3ConfigChange={(config) => {
                        setS3Dirty(true);
                        setS3Draft(config);
                    }}
                    checkS3={handleS3Check}
                    hardenS3={handleS3Harden}
                />
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Email notifications"
                description="Send email when a notification fires. In-app notifications always fire regardless."
            >
                <div className="space-y-3">
                    <SwitchRow
                        label="Email guests when added to share"
                        description="Guests have no in-app channel — without email they have no way to know."
                        checked={current.notifications.email.guestOnAclAdd}
                        onChange={(v) => updateEmailFlag('guestOnAclAdd', v)}
                    />
                    <SwitchRow
                        label="Email users when added to share"
                        description="In-app notification + bell already fires. Off by default."
                        checked={current.notifications.email.userOnAclAdd}
                        onChange={(v) => updateEmailFlag('userOnAclAdd', v)}
                    />
                    <SwitchRow
                        label="Email users for calendar invites"
                        description="Time-sensitive — matches Google/Outlook behavior."
                        checked={current.notifications.email.userOnCalendarInvite}
                        onChange={(v) => updateEmailFlag('userOnCalendarInvite', v)}
                    />
                    <SwitchRow
                        label="Email owner on access request"
                        description="Reaches owners not actively in Eigen."
                        checked={current.notifications.email.ownerOnAccessRequest}
                        onChange={(v) => updateEmailFlag('ownerOnAccessRequest', v)}
                    />
                </div>
            </SettingsSection>

            <Separator />

            <SettingsSection
                title="Landing page"
                description="Optional extra buttons on the public landing page. Each button links to a URL."
            >
                <div className="space-y-3">
                    {current.landing.links.map((link, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <Input
                                placeholder="Title"
                                maxLength={80}
                                value={link.title}
                                onChange={(e) => patchLink(i, { title: e.target.value })}
                            />
                            <Input
                                placeholder="https://..."
                                maxLength={2048}
                                value={link.url}
                                onChange={(e) => patchLink(i, { url: e.target.value })}
                            />
                            <TooltipButton
                                icon={Trash2}
                                tooltipText="Remove"
                                onClick={() => updateLinks(current.landing.links.filter((_, j) => j !== i))}
                            />
                        </div>
                    ))}
                    {current.landing.links.length < 20 && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => updateLinks([...current.landing.links, { title: '', url: '' }])}
                        >
                            <Plus className="h-4 w-4 mr-1" />
                            Add button
                        </Button>
                    )}
                </div>
            </SettingsSection>

            <SettingsFooter
                dirty={anyDirty}
                saving={saving}
                disabled={
                    orgName.trim() === '' ||
                    senderAddressInvalid ||
                    (current.defaults.mount.storageType === 's3' && !isS3ConfigValid(currentS3))
                }
                onSave={handleSave}
                onReset={handleReset}
            />
        </div>
    );
}

function normalizeLinks(links: LandingLink[]): LandingLink[] {
    return links
        .map((l) => ({ title: l.title.trim(), url: l.url.trim() }))
        .filter((l) => l.title !== '' && l.url !== '')
        .map((l) => {
            const scheme = l.url.match(/^https?:\/\//i)?.[0];
            return scheme
                ? { ...l, url: scheme.toLowerCase() + l.url.slice(scheme.length) }
                : { ...l, url: `https://${l.url}` };
        });
}

function SwitchRow({
    label,
    description,
    checked,
    onChange,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <Switch checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
