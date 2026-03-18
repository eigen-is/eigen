import {useState} from 'react';
import {Input} from '../../input';
import {Button} from '../../button';
import {Label} from '../../label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '../../select';
import {Alert, AlertDescription} from '../../alert';
import {AlertTriangle, CheckCircle2, Loader2, Wifi} from 'lucide-react';
import type {S3Config} from '@workspace/lib/types';

export type MountFormValues = {
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB: number;
    s3Config?: S3Config;
};

type S3CheckResult = {ok: boolean; message: string} | null;

type MountFormProps = {
    defaultStorageType?: MountFormValues['storageType'];
    defaultMaxSizeMB?: number;
    initialValues?: Partial<MountFormValues>;
    onSubmit: (values: MountFormValues) => void | Promise<void>;
    onCancel?: () => void;
    onS3Check?: (config: S3Config) => Promise<{ok: boolean; message: string}>;
    submitLabel?: string;
    isEdit?: boolean;
};

const EMPTY_S3: S3Config = {
    endpoint: '',
    bucket: '',
    prefix: '',
    accessKeyId: '',
    secretAccessKey: '',
};

export function MountForm({
    defaultStorageType = 'local',
    defaultMaxSizeMB = 500,
    initialValues,
    onSubmit,
    onCancel,
    onS3Check,
    submitLabel = 'Create Mount',
    isEdit = false,
}: MountFormProps) {
    const [name, setName] = useState(initialValues?.name ?? '');
    const [storageType, setStorageType] = useState<MountFormValues['storageType']>(
        initialValues?.storageType ?? defaultStorageType
    );
    const [maxSizeMB, setMaxSizeMB] = useState(initialValues?.maxSizeMB ?? defaultMaxSizeMB);
    const [s3Config, setS3Config] = useState<S3Config>(initialValues?.s3Config ?? {...EMPTY_S3});
    const [s3Check, setS3Check] = useState<S3CheckResult>(null);
    const [s3Checking, setS3Checking] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const isS3 = storageType === 's3';
    const s3Valid = isS3 && s3Config.endpoint && s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey;

    const handleStorageTypeChange = (value: string) => {
        setStorageType(value as MountFormValues['storageType']);
        setS3Check(null);
    };

    const handleS3Check = async () => {
        if (!onS3Check || !s3Valid) return;
        setS3Checking(true);
        setS3Check(null);
        try {
            const result = await onS3Check(s3Config);
            setS3Check(result);
        } catch {
            setS3Check({ok: false, message: 'Connection check failed'});
        } finally {
            setS3Checking(false);
        }
    };

    const updateS3 = (field: keyof S3Config, value: string) => {
        setS3Config(prev => ({...prev, [field]: value}));
        setS3Check(null);
    };

    const canSubmit = name.trim() && maxSizeMB >= 10 && (!isS3 || s3Valid);

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            await onSubmit({
                name: name.trim(),
                storageType,
                maxSizeMB,
                s3Config: isS3 ? s3Config : undefined,
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Shared Files"
                    autoFocus={!isEdit}
                />
            </div>

            <div className="space-y-1.5">
                <Label>Storage Type</Label>
                <Select value={storageType} onValueChange={handleStorageTypeChange} disabled={isEdit}>
                    <SelectTrigger>
                        <SelectValue/>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="local">Local (full names)</SelectItem>
                        <SelectItem value="local-key">Local (ID-based)</SelectItem>
                        <SelectItem value="s3">S3 Bucket</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-1.5">
                <Label>Max Size (MB)</Label>
                <Input
                    type="number"
                    min={10}
                    value={maxSizeMB}
                    onChange={e => setMaxSizeMB(e.target.valueAsNumber || 10)}
                />
            </div>

            {isS3 && (
                <div className="space-y-3 border rounded-lg p-4">
                    <h4 className="text-sm font-medium">S3 Configuration</h4>

                    {isEdit && (
                        <Alert>
                            <AlertTriangle className="h-4 w-4"/>
                            <AlertDescription>
                                Changing S3 settings on an existing mount can break access to stored files. Test the connection before saving.
                            </AlertDescription>
                        </Alert>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label>Endpoint</Label>
                            <Input
                                value={s3Config.endpoint}
                                onChange={e => updateS3('endpoint', e.target.value)}
                                placeholder="https://s3.amazonaws.com"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Bucket</Label>
                            <Input
                                value={s3Config.bucket}
                                onChange={e => updateS3('bucket', e.target.value)}
                                placeholder="my-bucket"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Prefix</Label>
                            <Input
                                value={s3Config.prefix}
                                onChange={e => updateS3('prefix', e.target.value)}
                                placeholder="optional/path"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Region</Label>
                            <Input
                                value={s3Config.region}
                                onChange={e => updateS3('region', e.target.value)}
                                placeholder="us-east-1"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Access Key ID</Label>
                            <Input
                                value={s3Config.accessKeyId}
                                onChange={e => updateS3('accessKeyId', e.target.value)}
                                placeholder="AKIA..."
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Secret Access Key</Label>
                            <Input
                                type="password"
                                value={s3Config.secretAccessKey}
                                onChange={e => updateS3('secretAccessKey', e.target.value)}
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

                        {s3Check && (
                            <span className={`text-sm flex items-center gap-1 ${s3Check.ok ? 'text-green-600' : 'text-destructive'}`}>
                                {s3Check.ok ? (
                                    <CheckCircle2 className="h-4 w-4"/>
                                ) : (
                                    <AlertTriangle className="h-4 w-4"/>
                                )}
                                {s3Check.message}
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
                {onCancel && (
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                )}
                <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
                    {submitting ? 'Saving...' : submitLabel}
                </Button>
            </div>
        </div>
    );
}
