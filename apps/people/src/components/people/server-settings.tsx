import {useState} from 'react';
import {Input} from '@workspace/ui/components/input';
import {Button} from '@workspace/ui/components/button';
import {Label} from '@workspace/ui/components/label';
import {Separator} from '@workspace/ui/components/separator';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {EigenLoader} from '@workspace/ui/components/layout/braket/eigen-loader';
import {
    useCheckS3Connection,
    useServerS3Config,
    useServerSettings,
    useUpdateServerS3Config,
    useUpdateServerSettings
} from '@workspace/lib/settings';

import type {ServerSettings} from '@workspace/lib/types/settings';
import type {S3Config} from '@workspace/lib/types';
import {AlertTriangle, CheckCircle2, Loader2, Wifi} from 'lucide-react';

type SettingsDraft = {
    quotas?: Partial<ServerSettings['quotas']>;
    defaults?: { mount?: Partial<ServerSettings['defaults']['mount']> };
};

const EMPTY_S3: S3Config = {
    endpoint: '',
    bucket: '',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
};

export function ServerSettingsPage() {
    const {data: settings, isLoading} = useServerSettings();
    const updateSettings = useUpdateServerSettings();
    const {data: s3Config} = useServerS3Config();
    const updateS3Config = useUpdateServerS3Config();
    const s3Check = useCheckS3Connection();

    const [draft, setDraft] = useState<SettingsDraft>({});
    const [dirty, setDirty] = useState(false);
    const [s3Draft, setS3Draft] = useState<S3Config | null>(null);
    const [s3Dirty, setS3Dirty] = useState(false);
    const [s3CheckResult, setS3CheckResult] = useState<{ok: boolean; message: string} | null>(null);
    const [s3Checking, setS3Checking] = useState(false);

    if (isLoading || !settings) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const current = {
        quotas: {...settings.quotas, ...draft.quotas},
        defaults: {
            mount: {...settings.defaults.mount, ...draft.defaults?.mount},
        },
    };

    const updateQuota = (key: keyof ServerSettings['quotas'], value: number) => {
        if (isNaN(value) || value < 0) return;
        setDirty(true);
        setDraft(prev => ({...prev, quotas: {...prev.quotas, [key]: value}}));
    };

    const updateStorageType = (value: ServerSettings['defaults']['mount']['storageType']) => {
        setDirty(true);
        setDraft(prev => ({...prev, defaults: {mount: {storageType: value}}}));
    };

    const handleSave = async () => {
        await updateSettings.mutateAsync(draft as Record<string, unknown>);
        setDraft({});
        setDirty(false);
    };

    const handleReset = () => {
        setDraft({});
        setDirty(false);
    };

    const currentStorageType = current.defaults.mount.storageType;
    const isS3 = currentStorageType === 's3';
    const currentS3 = s3Draft ?? s3Config ?? EMPTY_S3;
    const s3Valid = currentS3.endpoint && currentS3.bucket && currentS3.accessKeyId && currentS3.secretAccessKey;

    const updateS3Field = (field: keyof S3Config, value: string) => {
        setS3Dirty(true);
        setS3Draft(prev => ({...(prev ?? s3Config ?? EMPTY_S3), [field]: value}));
        setS3CheckResult(null);
    };

    const handleS3Check = async () => {
        if (!s3Valid) return;
        setS3Checking(true);
        setS3CheckResult(null);
        try {
            const result = await s3Check.mutateAsync(currentS3);
            setS3CheckResult(result);
        } catch {
            setS3CheckResult({ok: false, message: 'Connection check failed'});
        } finally {
            setS3Checking(false);
        }
    };

    const handleSaveS3 = async () => {
        if (!s3Draft) return;
        await updateS3Config.mutateAsync(s3Draft);
        setS3Draft(null);
        setS3Dirty(false);
    };

    const handleResetS3 = () => {
        setS3Draft(null);
        setS3Dirty(false);
        setS3CheckResult(null);
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
                            onChange={e => updateQuota('mailAndContactsMaxMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Default Mount (MB)</Label>
                        <Input
                            type="number"
                            min={10}
                            value={current.quotas.defaultMountMaxSizeMB}
                            onChange={e => updateQuota('defaultMountMaxSizeMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Max Upload (MB)</Label>
                        <Input
                            type="number"
                            min={1}
                            value={current.quotas.maxUploadSizeMB}
                            onChange={e => updateQuota('maxUploadSizeMB', e.target.valueAsNumber)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Max Batch Upload (MB)</Label>
                        <Input
                            type="number"
                            min={1}
                            value={current.quotas.maxBatchUploadSizeMB}
                            onChange={e => updateQuota('maxBatchUploadSizeMB', e.target.valueAsNumber)}
                        />
                    </div>
                </div>
            </div>

            <Separator/>

            <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Defaults</h3>

                <div className="space-y-1.5">
                    <Label>Default Storage Type</Label>
                    <Select
                        value={current.defaults.mount.storageType}
                        onValueChange={v => updateStorageType(v as ServerSettings['defaults']['mount']['storageType'])}
                    >
                        <SelectTrigger className="w-48">
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="local-id">Local (ID-based)</SelectItem>
                            <SelectItem value="local-fullnames">Local (Full names)</SelectItem>
                            <SelectItem value="s3">S3</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {isS3 && (
                    <div className="space-y-3 border rounded-lg p-4">
                        <h4 className="text-sm font-medium">S3 Configuration</h4>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label>Endpoint</Label>
                                <Input
                                    value={currentS3.endpoint}
                                    onChange={e => updateS3Field('endpoint', e.target.value)}
                                    placeholder="https://s3.amazonaws.com"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Bucket</Label>
                                <Input
                                    value={currentS3.bucket}
                                    onChange={e => updateS3Field('bucket', e.target.value)}
                                    placeholder="my-bucket"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Prefix</Label>
                                <Input
                                    value={currentS3.prefix}
                                    onChange={e => updateS3Field('prefix', e.target.value)}
                                    placeholder="optional/path"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Region</Label>
                                <Input
                                    value={currentS3.region ?? ''}
                                    onChange={e => updateS3Field('region', e.target.value)}
                                    placeholder="us-east-1"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Access Key ID</Label>
                                <Input
                                    value={currentS3.accessKeyId}
                                    onChange={e => updateS3Field('accessKeyId', e.target.value)}
                                    placeholder="AKIA..."
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Secret Access Key</Label>
                                <Input
                                    type="password"
                                    value={currentS3.secretAccessKey}
                                    onChange={e => updateS3Field('secretAccessKey', e.target.value)}
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handleS3Check}
                                disabled={!s3Valid || s3Checking}
                            >
                                {s3Checking ? (
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin"/>
                                ) : (
                                    <Wifi className="h-4 w-4 mr-1"/>
                                )}
                                Test Connection
                            </Button>

                            {s3CheckResult && (
                                <span className={`text-sm flex items-center gap-1 ${s3CheckResult.ok ? 'text-green-600' : 'text-destructive'}`}>
                                    {s3CheckResult.ok ? (
                                        <CheckCircle2 className="h-4 w-4"/>
                                    ) : (
                                        <AlertTriangle className="h-4 w-4"/>
                                    )}
                                    {s3CheckResult.message}
                                </span>
                            )}
                        </div>

                        {s3Dirty && (
                            <div className="flex items-center justify-end gap-2 pt-2">
                                <Button variant="outline" size="sm" onClick={handleResetS3}>Reset</Button>
                                <Button size="sm" onClick={handleSaveS3} disabled={!s3Valid || updateS3Config.isPending}>
                                    {updateS3Config.isPending ? 'Saving...' : 'Save S3 Config'}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {dirty && (
                <>
                    <Separator/>
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" onClick={handleReset}>Reset</Button>
                        <Button onClick={handleSave} disabled={updateSettings.isPending}>
                            {updateSettings.isPending ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
