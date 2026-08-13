import {
    useCheckS3Connection,
    useServerS3Config,
    useServerSettings,
    useUpdateServerS3Config,
    useUpdateServerSettings,
} from '@workspace/lib/settings';
import { EMPTY_S3, isS3ConfigValid } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { LandingLink, ServerSettings, ServerStorageType } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { LoadingState, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { StorageTypePicker } from './storage-type-picker';

type EmailFlag = keyof ServerSettings['notifications']['email'];

export function ServerSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const { data: s3Config } = useServerS3Config();
    const updateS3Config = useUpdateServerS3Config();
    const s3Check = useCheckS3Connection();

    const [draft, setDraft] = useState<DeepPartial<ServerSettings>>({});
    const [dirty, setDirty] = useState(false);
    const [s3Draft, setS3Draft] = useState<S3Config | null>(null);
    const [s3Dirty, setS3Dirty] = useState(false);

    if (isLoading || !settings) {
        return <LoadingState />;
    }

    const current = {
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

    const updateLinks = (links: LandingLink[]) => {
        setDirty(true);
        setDraft((prev) => ({ ...prev, landing: { links } }));
    };

    const patchLink = (index: number, patch: Partial<LandingLink>) =>
        updateLinks(current.landing.links.map((link, i) => (i === index ? { ...link, ...patch } : link)));

    const currentS3 = s3Draft ?? s3Config ?? EMPTY_S3;
    const anyDirty = dirty || s3Dirty;
    const saving = updateSettings.isPending || updateS3Config.isPending;
    const handleS3Check = (config: S3Config) => s3Check.mutateAsync(config);

    const handleSave = async () => {
        if (s3Dirty && s3Draft && current.defaults.mount.storageType === 's3')
            await updateS3Config.mutateAsync(s3Draft);
        if (dirty)
            await updateSettings.mutateAsync(
                draft.landing ? { ...draft, landing: { links: normalizeLinks(draft.landing.links ?? []) } } : draft,
            );
        setDraft({});
        setDirty(false);
        setS3Draft(null);
        setS3Dirty(false);
    };

    const handleReset = () => {
        setDraft({});
        setDirty(false);
        setS3Draft(null);
        setS3Dirty(false);
    };

    return (
        <div className="space-y-6">
            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Storage Quotas</h3>

                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>Mail & Contacts (MB)</Label>
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
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Defaults</h3>

                <p className="text-sm text-muted-foreground">
                    The storage type used for user Drives. Changing this only affects new users: existing users will not
                    be migrated to the newly selected storage type.
                </p>

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
                />
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Email notifications
                </h3>
                <p className="text-sm text-muted-foreground">
                    Send email when a notification fires. In-app notifications always fire regardless.
                </p>

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
                        description="Time-sensitive — matches Google/Outlook behaviour."
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
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Landing page</h3>
                <p className="text-sm text-muted-foreground">
                    Optional extra buttons on the public landing page. Each button links to a URL.
                </p>

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
            </div>

            {anyDirty && (
                <>
                    <Separator />
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={handleReset}>
                            Reset
                        </Button>
                        <Button
                            onClick={handleSave}
                            disabled={
                                saving || (current.defaults.mount.storageType === 's3' && !isS3ConfigValid(currentS3))
                            }
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </Button>
                    </div>
                </>
            )}
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
