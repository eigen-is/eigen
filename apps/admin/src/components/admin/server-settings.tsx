// The admin's Server settings page, in sections such as the organization's name, the sender of the server's mail,
// the storage quotas and defaults, and the landing page's links. It saves through the server-settings hooks.

import { defaultSenderAddress } from '@workspace/lib/constants/mail';
import { UPLOAD_CAP_MAX_MB } from '@workspace/lib/constants/mount';
import {
    LANDING_LINK_TITLE_MAX,
    LANDING_LINK_URL_MAX,
    LANDING_LINKS_MAX,
    QUOTA_MIN_MB,
} from '@workspace/lib/constants/settings';
import { useHomeDataLabel, useMailEnabled, usePublicConfig } from '@workspace/lib/public';
import {
    useCheckS3Connection,
    useHardenS3Bucket,
    useSendTestMail,
    useServerS3Config,
    useServerSettings,
    useServerStatus,
    useUpdateOrgName,
    useUpdateServerS3Config,
    useUpdateServerSettings,
} from '@workspace/lib/settings';
import type { S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3, isS3ConfigValid, keepsSavedSecret } from '@workspace/lib/types/mount';
import type { LandingLink, ServerSettings, ServerSettingsSaved } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { validateEmailAddress } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LoadingState, SettingsFooter, SettingsSection } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ServerBackupSection } from './server-backup-section';
import { ServerStatusSection } from './server-status-section';
import { StorageTypePicker } from './storage-type-picker';
import { SwitchRow } from './switch-row';

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
    const updateOrgName = useUpdateOrgName(config?.orgId);
    const sendTestMail = useSendTestMail();
    const { data: status } = useServerStatus();

    const [draft, setDraft] = useState<DeepPartial<ServerSettings>>({});
    const [dirty, setDirty] = useState(false);
    const [s3Draft, setS3Draft] = useState<S3Config | null>(null);
    const [s3Dirty, setS3Dirty] = useState(false);
    const [orgNameDraft, setOrgNameDraft] = useState<string | null>(null);
    const [backupNotice, setBackupNotice] = useState<Pick<ServerSettingsSaved, 'notice' | 'warning'> | null>(null);

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
            links: draft.landing?.links ?? settings.landing.links,
            showInstall: draft.landing?.showInstall ?? settings.landing.showInstall,
        },
        backups: {
            schedule: { ...settings.backups.schedule, ...draft.backups?.schedule },
            upload: {
                ...settings.backups.upload,
                ...draft.backups?.upload,
                s3: { ...settings.backups.upload.s3, ...draft.backups?.upload?.s3 },
            },
        },
    };

    const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
        if (Number.isNaN(value) || value < 0) return;
        setDirty(true);
        setDraft((prev) => ({ ...prev, quotas: { ...prev.quotas, [key]: value } }));
    };

    const updateEmailFlag = (key: keyof ServerSettings['notifications']['email'], value: boolean) => {
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

    const updateLanding = (patch: Partial<ServerSettings['landing']>) => {
        setDirty(true);
        setDraft((prev) => ({ ...prev, landing: { ...prev.landing, ...patch } }));
    };

    const updateLinks = (links: LandingLink[]) => updateLanding({ links });

    // The draft keeps only the half of the backup settings the owner changed. The server checks the bucket only when a
    // save carries the upload half, so a change to the schedule alone skips that check.
    const updateBackups = (patch: DeepPartial<ServerSettings['backups']>) => {
        setDirty(true);
        setDraft((prev) => ({
            ...prev,
            backups: {
                ...prev.backups,
                ...(patch.schedule && { schedule: { ...prev.backups?.schedule, ...patch.schedule } }),
                ...(patch.upload && { upload: { ...prev.backups?.upload, ...patch.upload } }),
            },
        }));
    };

    const patchLink = (index: number, patch: Partial<LandingLink>) =>
        updateLinks(current.landing.links.map((link, i) => (i === index ? { ...link, ...patch } : link)));

    const currentS3 = s3Draft ?? s3Config ?? EMPTY_S3;
    const anyDirty = dirty || s3Dirty || orgNameDraft !== null;
    const saving = updateSettings.isPending || updateS3Config.isPending || updateOrgName.isPending;
    // The test mail goes out from the saved sender, so an unsaved one would test the wrong thing.
    const senderDirty = draft.mail !== undefined || orgNameDraft !== null;
    // A server without mailboxes sends its mail through the relay named at setup, if there is one. The status says
    // which, so relayHost is undefined until it loads.
    const relayHost = status?.relayHost;
    const mailOff = !mailEnabled && relayHost === null;
    const senderAddressInvalid = current.mail.senderAddress !== '' && !validateEmailAddress(current.mail.senderAddress);
    const homeDataTooSmall = current.quotas.homeDataMaxMB < QUOTA_MIN_MB;
    const mountTooSmall = current.quotas.defaultMountMaxSizeMB < QUOTA_MIN_MB;
    const uploadOutOfRange = current.quotas.maxUploadSizeMB < 1 || current.quotas.maxUploadSizeMB > UPLOAD_CAP_MAX_MB;
    const savedDestination = settings.backups.upload.s3;
    const backupSecretSaved =
        savedDestination.accessKeyId !== '' && keepsSavedSecret(current.backups.upload.s3, savedDestination);

    const handleSave = async () => {
        if (orgNameDraft !== null) await updateOrgName.mutateAsync(orgNameDraft.trim());
        if (s3Dirty && s3Draft && current.defaults.mount.storageType === 's3')
            await updateS3Config.mutateAsync(s3Draft);
        if (dirty) {
            const saved = await updateSettings.mutateAsync(
                draft.landing?.links
                    ? { ...draft, landing: { ...draft.landing, links: normalizeLinks(draft.landing.links) } }
                    : draft,
            );
            // A new backup bucket brings a one-time notice to keep its keys off this server. A bucket that lacks
            // something, such as versioning, warns on every save of the upload settings, even when it stayed the same.
            if (saved.notice || saved.warning) setBackupNotice({ notice: saved.notice, warning: saved.warning });
        }
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
                {relayHost && (
                    <SwitchRow
                        label="Relay sends as users"
                        description={`Your relay allows sending from any address at ${config.mailDomain}. Off, mail on a user's behalf goes out as 'Name via ${orgName}' from the sender address.`}
                        checked={current.mail.relaySendsAsUsers}
                        onChange={(relaySendsAsUsers) => updateMail({ relaySendsAsUsers })}
                    />
                )}
                {mailOff ? (
                    <p className="text-xs text-muted-foreground">
                        Mail is off: this server hosts no mailboxes and has no relay, so it sends no email.
                    </p>
                ) : (
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
                )}
            </SettingsSection>

            <Separator />

            <SettingsSection title="Storage quotas">
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>{homeDataLabel} (MB)</Label>
                        <Input
                            type="number"
                            min={QUOTA_MIN_MB}
                            value={current.quotas.homeDataMaxMB}
                            onChange={(e) => updateQuota('homeDataMaxMB', e.target.valueAsNumber)}
                        />
                        {homeDataTooSmall && <p className="text-xs text-destructive">At least {QUOTA_MIN_MB} MB</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label>Default mount (MB)</Label>
                        <Input
                            type="number"
                            min={QUOTA_MIN_MB}
                            value={current.quotas.defaultMountMaxSizeMB}
                            onChange={(e) => updateQuota('defaultMountMaxSizeMB', e.target.valueAsNumber)}
                        />
                        {mountTooSmall && <p className="text-xs text-destructive">At least {QUOTA_MIN_MB} MB</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label>Max upload (MB)</Label>
                        <Input
                            type="number"
                            min={1}
                            max={UPLOAD_CAP_MAX_MB}
                            value={current.quotas.maxUploadSizeMB}
                            onChange={(e) => updateQuota('maxUploadSizeMB', e.target.valueAsNumber)}
                        />
                        <p className={cn('text-xs', uploadOutOfRange ? 'text-destructive' : 'text-muted-foreground')}>
                            At most {UPLOAD_CAP_MAX_MB} MB, the largest upload the server takes.
                        </p>
                    </div>
                    <div className="space-y-1.5">
                        <Label>Trash retention (days)</Label>
                        <Input
                            type="number"
                            min={0}
                            value={current.quotas.trashRetentionDays}
                            onChange={(e) => updateQuota('trashRetentionDays', e.target.valueAsNumber)}
                        />
                        <p className="text-xs text-muted-foreground">
                            0 keeps deleted files until the Trash is emptied.
                        </p>
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
                    onStorageTypeChange={(type) => {
                        setDirty(true);
                        setDraft((prev) => ({ ...prev, defaults: { mount: { storageType: type } } }));
                    }}
                    s3Config={currentS3}
                    onS3ConfigChange={(config) => {
                        setS3Dirty(true);
                        setS3Draft(config);
                    }}
                    checkS3={(config) => s3Check.mutateAsync(config)}
                    hardenS3={(config, noncurrentDays) => s3Harden.mutateAsync({ ...config, noncurrentDays })}
                />
            </SettingsSection>

            <Separator />

            <ServerBackupSection
                value={current.backups}
                onChange={updateBackups}
                secretSaved={backupSecretSaved}
                uploadSaved={settings.backups.upload.enabled}
                saveNotice={backupNotice}
                onDismissNotice={() => setBackupNotice(null)}
            />

            <Separator />

            <SettingsSection
                title="Email notifications"
                description="Send email when a notification fires. Anyone with an account gets the in-app notification either way."
            >
                <div className="space-y-3">
                    <SwitchRow
                        label="Email guests when added to share"
                        description="A guest rarely has Eigen open, and one who never signed in has no bell, so email is how they find out."
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
                        label="Email guests when assigned a comment or card"
                        description="A guest rarely has Eigen open, and one who never signed in has no bell."
                        checked={current.notifications.email.guestOnAssign}
                        onChange={(v) => updateEmailFlag('guestOnAssign', v)}
                    />
                    <SwitchRow
                        label="Email users when assigned a comment or card"
                        description="In-app notification + bell already fires. Off by default."
                        checked={current.notifications.email.userOnAssign}
                        onChange={(v) => updateEmailFlag('userOnAssign', v)}
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
                description="Extra buttons and the install line on the public landing page."
            >
                <div className="space-y-3">
                    <SwitchRow
                        label="Show install section"
                        description="Adds the install instructions to the public landing page."
                        checked={current.landing.showInstall}
                        onChange={(v) => updateLanding({ showInstall: v })}
                    />
                    {current.landing.links.map((link, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <Input
                                placeholder="Title"
                                maxLength={LANDING_LINK_TITLE_MAX}
                                value={link.title}
                                onChange={(e) => patchLink(i, { title: e.target.value })}
                            />
                            <Input
                                placeholder="https://..."
                                maxLength={LANDING_LINK_URL_MAX}
                                value={link.url}
                                onChange={(e) => patchLink(i, { url: e.target.value })}
                            />
                            <TooltipButton
                                icon={Trash2}
                                tooltipText={`Remove ${link.title.trim() || link.url.trim() || 'empty link'}`}
                                onClick={() => updateLinks(current.landing.links.filter((_, j) => j !== i))}
                            />
                        </div>
                    ))}
                    {current.landing.links.length < LANDING_LINKS_MAX && (
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
                    homeDataTooSmall ||
                    mountTooSmall ||
                    uploadOutOfRange ||
                    (current.defaults.mount.storageType === 's3' && !isS3ConfigValid(currentS3)) ||
                    (current.backups.upload.enabled && !isS3ConfigValid(current.backups.upload.s3, backupSecretSaved))
                }
                onSave={handleSave}
                onReset={handleReset}
            />
        </div>
    );
}

// The server refuses an empty title or URL and a URL without http:// or https://, so a save mends what it can first.
function normalizeLinks(links: readonly LandingLink[]): LandingLink[] {
    return links
        .map((link) => ({ title: link.title.trim(), url: link.url.trim() }))
        .filter((link) => link.title !== '' && link.url !== '')
        .map((link) => {
            const scheme = link.url.match(/^https?:\/\//i)?.[0];
            return scheme
                ? { ...link, url: scheme.toLowerCase() + link.url.slice(scheme.length) }
                : { ...link, url: `https://${link.url}` };
        });
}
