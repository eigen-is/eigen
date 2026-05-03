import {
    useServerS3Config,
    useServerSettings,
    useUpdateServerS3Config,
    useUpdateServerSettings,
} from '@workspace/lib/settings';
import { EMPTY_S3, type S3Config } from '@workspace/lib/types';
import type { ServerSettings, ServerStorageType } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Separator } from '@workspace/ui/components/separator';
import { useState } from 'react';
import { StorageTypePicker } from './storage-type-picker';

type SettingsDraft = {
    quotas?: Partial<ServerSettings['quotas']>;
    defaults?: { mount?: Partial<ServerSettings['defaults']['mount']> };
};

export function ServerSettingsPage() {
    const { data: settings, isLoading } = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const { data: s3Config } = useServerS3Config();
    const updateS3Config = useUpdateServerS3Config();

    const [draft, setDraft] = useState<SettingsDraft>({});
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
    };

    const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
        if (Number.isNaN(value) || value < 0) return;
        setDirty(true);
        setDraft((prev) => ({ ...prev, quotas: { ...prev.quotas, [key]: value } }));
    };

    const currentS3 = s3Draft ?? s3Config ?? EMPTY_S3;
    const anyDirty = dirty || s3Dirty;
    const saving = updateSettings.isPending || updateS3Config.isPending;

    const handleSave = async () => {
        if (s3Dirty && s3Draft && current.defaults.mount.storageType === 's3')
            await updateS3Config.mutateAsync(s3Draft);
        if (dirty) await updateSettings.mutateAsync(draft);
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
        <div className="p-6 max-w-2xl space-y-6">
            <h2 className="text-xl font-semibold">Server Settings</h2>

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
                />
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
                                saving ||
                                (current.defaults.mount.storageType === 's3' &&
                                    (!currentS3.endpoint ||
                                        !currentS3.bucket ||
                                        !currentS3.accessKeyId ||
                                        !currentS3.secretAccessKey))
                            }
                        >
                            {saving ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
