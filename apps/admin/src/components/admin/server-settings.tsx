// The admin's Server settings page, in sections such as the organization's name, the sender of the server's mail,
// the storage quotas and defaults, and the landing page's links. Its changes collect in drafts on a PageForm, and Save
// writes the ones that changed in one save, which says once that the page saved, once every field is valid.

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
    useSaveServerSettingsPage,
    useSendTestMail,
    useServerS3Config,
    useServerSettings,
    useServerStatus,
} from '@workspace/lib/settings';
import type { S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3, isS3ConfigValid, keepsSavedSecret } from '@workspace/lib/types/mount';
import type { LandingLink, ServerSettings, ServerSettingsSaved } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { FIELD_MESSAGES, validateEmailAddress } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { FieldError } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LoadingState, PageForm, SettingsSection } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Separator } from '@workspace/ui/components/separator';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { usePageDraft } from './hooks/use-page-draft';
import { ServerBackupSection } from './server-backup-section';
import { ServerStatusSection } from './server-status-section';
import { StorageTypePicker } from './storage-type-picker';
import { SwitchRow } from './switch-row';

type PublicConfig = NonNullable<ReturnType<typeof usePublicConfig>['data']>;

export function ServerSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const { data: config } = usePublicConfig();

    if (isLoading || !settings || !config) {
        return <LoadingState />;
    }
    return <ServerSettingsForm settings={settings} config={config} />;
}

// The page's fields, mounted once the settings and the organization have loaded, so every draft starts from them.
function ServerSettingsForm({ settings, config }: { settings: ServerSettings; config: PublicConfig }) {
    const { data: s3Config } = useServerS3Config();
    const s3Check = useCheckS3Connection();
    const s3Harden = useHardenS3Bucket();
    const homeDataLabel = useHomeDataLabel();
    const mailEnabled = useMailEnabled();
    const save = useSaveServerSettingsPage(config.orgId);
    const sendTestMail = useSendTestMail();
    const { data: status } = useServerStatus();

    const { draft, setDraft, current, loaded, changed: settingsChanged, reset } = usePageDraft(settings, withDraft);
    const [s3Draft, setS3Draft] = useState<S3Config | null>(null);
    const [orgNameDraft, setOrgNameDraft] = useState<string | null>(null);
    const [backupNotice, setBackupNotice] = useState<Pick<ServerSettingsSaved, 'notice' | 'warning'> | null>(null);
    const fieldId = useId();

    const orgName = orgNameDraft ?? config.orgName;
    const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
        if (Number.isNaN(value) || value < 0) return;
        setDraft((prev) => ({ ...prev, quotas: { ...prev.quotas, [key]: value } }));
    };

    const updateEmailFlag = (key: keyof ServerSettings['notifications']['email'], value: boolean) => {
        setDraft((prev) => ({
            ...prev,
            notifications: { email: { ...prev.notifications?.email, [key]: value } },
        }));
    };

    const updateMail = (patch: Partial<ServerSettings['mail']>) =>
        setDraft((prev) => ({ ...prev, mail: { ...prev.mail, ...patch } }));

    const updateLanding = (patch: Partial<ServerSettings['landing']>) =>
        setDraft((prev) => ({ ...prev, landing: { ...prev.landing, ...patch } }));

    const updateLinks = (links: LandingLink[]) => updateLanding({ links });

    // The draft keeps only the half of the backup settings the owner changed. The server checks the bucket only when a
    // save carries the upload half, so a change to the schedule alone skips that check.
    const updateBackups = (patch: DeepPartial<ServerSettings['backups']>) => {
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

    const savedS3 = s3Config ?? EMPTY_S3;
    const currentS3 = s3Draft ?? savedS3;
    const s3Changed =
        current.defaults.mount.storageType === 's3' && JSON.stringify(currentS3) !== JSON.stringify(savedS3);
    const orgNameChanged = orgName !== config.orgName;
    // The test mail goes out from the saved sender, so an unsaved one would test the wrong thing.
    const senderChanged = orgNameChanged || JSON.stringify(current.mail) !== JSON.stringify(loaded.mail);
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

    const invalid =
        !orgName.trim() ||
        senderAddressInvalid ||
        homeDataTooSmall ||
        mountTooSmall ||
        uploadOutOfRange ||
        (current.defaults.mount.storageType === 's3' && !isS3ConfigValid(currentS3)) ||
        (current.backups.upload.enabled && !isS3ConfigValid(current.backups.upload.s3, backupSecretSaved));

    const handleSave = async () => {
        if (invalid) return false;
        const links = draft.landing?.links;
        const settingsDraft = links ? { ...draft, landing: { ...draft.landing, links: normalizeLinks(links) } } : draft;
        const result = await save.mutateAsync({
            orgName: orgNameChanged ? orgName.trim() : undefined,
            s3Config: s3Changed ? currentS3 : undefined,
            settings: settingsChanged ? settingsDraft : undefined,
        });
        // A new backup bucket brings a one-time notice to keep its keys off this server. A bucket that lacks
        // something, such as versioning, warns on every save of the upload settings, even when it stayed the same.
        if (result?.notice || result?.warning) setBackupNotice({ notice: result.notice, warning: result.warning });
        handleReset();
    };

    const handleReset = () => {
        reset();
        setS3Draft(null);
        setOrgNameDraft(null);
    };

    return (
        <PageForm changed={orgNameChanged || s3Changed || settingsChanged} onSubmit={handleSave} onReset={handleReset}>
            <SettingsSection title="General">
                <RequiredTextField
                    label="Organization name"
                    maxLength={100}
                    value={orgName}
                    onChange={setOrgNameDraft}
                    message={FIELD_MESSAGES.nameMissing}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-domain`}>Web address</Label>
                        <Input id={`${fieldId}-domain`} value={config.domain} disabled />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-mail-domain`}>Mail domain</Label>
                        <Input id={`${fieldId}-mail-domain`} value={config.mailDomain} disabled />
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-sender-name`}>Sender name</Label>
                        <Input
                            id={`${fieldId}-sender-name`}
                            maxLength={100}
                            placeholder={orgName}
                            value={current.mail.senderName}
                            onChange={(e) => updateMail({ senderName: e.target.value })}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-sender-address`}>Sender address</Label>
                        <Input
                            id={`${fieldId}-sender-address`}
                            type="email"
                            placeholder={defaultSenderAddress(config.mailDomain)}
                            value={current.mail.senderAddress}
                            onChange={(e) => updateMail({ senderAddress: e.target.value.trim() })}
                            aria-invalid={senderAddressInvalid || undefined}
                        />
                        {senderAddressInvalid && <FieldError>{FIELD_MESSAGES.invalidEmail}</FieldError>}
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
                            pending={sendTestMail.isPending}
                            disabled={senderChanged}
                        >
                            Send test mail
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {senderChanged ? 'Save first: the test uses the saved sender.' : 'Sends one mail to you.'}
                        </p>
                    </div>
                )}
            </SettingsSection>

            <Separator />

            <SettingsSection title="Storage quotas">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-home-data`}>{homeDataLabel} (MB)</Label>
                        <Input
                            id={`${fieldId}-home-data`}
                            type="number"
                            min={QUOTA_MIN_MB}
                            value={current.quotas.homeDataMaxMB}
                            onChange={(e) => updateQuota('homeDataMaxMB', e.target.valueAsNumber)}
                            aria-invalid={homeDataTooSmall || undefined}
                        />
                        {homeDataTooSmall && <FieldError>At least {QUOTA_MIN_MB} MB</FieldError>}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-mount`}>Default mount (MB)</Label>
                        <Input
                            id={`${fieldId}-mount`}
                            type="number"
                            min={QUOTA_MIN_MB}
                            value={current.quotas.defaultMountMaxSizeMB}
                            onChange={(e) => updateQuota('defaultMountMaxSizeMB', e.target.valueAsNumber)}
                            aria-invalid={mountTooSmall || undefined}
                        />
                        {mountTooSmall && <FieldError>At least {QUOTA_MIN_MB} MB</FieldError>}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-upload`}>Max upload (MB)</Label>
                        <Input
                            id={`${fieldId}-upload`}
                            type="number"
                            min={1}
                            max={UPLOAD_CAP_MAX_MB}
                            value={current.quotas.maxUploadSizeMB}
                            onChange={(e) => updateQuota('maxUploadSizeMB', e.target.valueAsNumber)}
                            aria-invalid={uploadOutOfRange || undefined}
                        />
                        {uploadOutOfRange ? (
                            <FieldError>
                                Between 1 and {UPLOAD_CAP_MAX_MB} MB, the largest upload the server takes
                            </FieldError>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                At most {UPLOAD_CAP_MAX_MB} MB, the largest upload the server takes.
                            </p>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-trash`}>Trash retention (days)</Label>
                        <Input
                            id={`${fieldId}-trash`}
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
                    onStorageTypeChange={(type) =>
                        setDraft((prev) => ({ ...prev, defaults: { mount: { storageType: type } } }))
                    }
                    s3Config={currentS3}
                    onS3ConfigChange={setS3Draft}
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
                        description="They already get a notification in Eigen. Off by default."
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
                        description="They already get a notification in Eigen. Off by default."
                        checked={current.notifications.email.userOnAssign}
                        onChange={(v) => updateEmailFlag('userOnAssign', v)}
                    />
                    <SwitchRow
                        label="Email users for calendar invites"
                        description="An invitation can't wait, and Google Calendar and Outlook email it too."
                        checked={current.notifications.email.userOnCalendarInvite}
                        onChange={(v) => updateEmailFlag('userOnCalendarInvite', v)}
                    />
                    <SwitchRow
                        label="Email owner on access request"
                        description="Reaches an owner who doesn't have Eigen open."
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
        </PageForm>
    );
}

function withDraft(settings: ServerSettings, draft: DeepPartial<ServerSettings>) {
    return {
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
