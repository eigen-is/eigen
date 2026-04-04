import { useCheckS3Connection } from '@workspace/lib/settings';
import type { S3Config } from '@workspace/lib/types';
import type { ServerStorageType } from '@workspace/lib/types/settings';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { AlertTriangle, CheckCircle2, Loader2, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';

type S3CheckResult = { ok: boolean; message: string };

type StorageTypePickerProps = {
    storageType: ServerStorageType;
    onStorageTypeChange: (type: ServerStorageType) => void;
    s3Config: S3Config;
    onS3ConfigChange: (config: S3Config) => void;
    checkS3?: (config: S3Config) => Promise<S3CheckResult>;
    onS3Verified?: (verified: boolean) => void;
};

export function StorageTypePicker({
    storageType,
    onStorageTypeChange,
    s3Config,
    onS3ConfigChange,
    checkS3: checkS3Prop,
    onS3Verified,
}: StorageTypePickerProps) {
    const s3Check = useCheckS3Connection();
    const [s3CheckResult, setS3CheckResult] = useState<S3CheckResult | null>(null);
    const [s3Checking, setS3Checking] = useState(false);

    const isS3 = storageType === 's3';
    const s3Valid = s3Config.endpoint && s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey;

    useEffect(() => {
        onS3Verified?.(!isS3 || !!s3CheckResult?.ok);
    }, [isS3, s3CheckResult, onS3Verified]);

    const updateS3Field = (field: keyof S3Config, value: string) => {
        onS3ConfigChange({ ...s3Config, [field]: value });
        setS3CheckResult(null);
    };

    const handleStorageTypeChange = (type: ServerStorageType) => {
        onStorageTypeChange(type);
        setS3CheckResult(null);
    };

    const handleS3Check = async () => {
        if (!s3Valid) return;
        setS3Checking(true);
        setS3CheckResult(null);
        try {
            const result = checkS3Prop ? await checkS3Prop(s3Config) : await s3Check.mutateAsync(s3Config);
            setS3CheckResult(result);
        } catch {
            setS3CheckResult({ ok: false, message: 'Connection check failed' });
        } finally {
            setS3Checking(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-1.5">
                <Label>Storage Type</Label>
                <Select value={storageType} onValueChange={(v) => handleStorageTypeChange(v as ServerStorageType)}>
                    <SelectTrigger className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="local-id">Local (ID-based)</SelectItem>
                        <SelectItem value="local-fullnames">Local (Full names)</SelectItem>
                        <SelectItem value="s3">S3 Bucket</SelectItem>
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
                                value={s3Config.endpoint}
                                onChange={(e) => updateS3Field('endpoint', e.target.value)}
                                placeholder="https://s3.amazonaws.com"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Bucket</Label>
                            <Input
                                value={s3Config.bucket}
                                onChange={(e) => updateS3Field('bucket', e.target.value)}
                                placeholder="my-bucket"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Prefix</Label>
                            <Input
                                value={s3Config.prefix}
                                onChange={(e) => updateS3Field('prefix', e.target.value)}
                                placeholder="optional/path"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Region</Label>
                            <Input
                                value={s3Config.region ?? ''}
                                onChange={(e) => updateS3Field('region', e.target.value)}
                                placeholder="eu-west-1"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Access Key ID</Label>
                            <Input
                                value={s3Config.accessKeyId}
                                onChange={(e) => updateS3Field('accessKeyId', e.target.value)}
                                placeholder="AKIA..."
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Secret Access Key</Label>
                            <Input
                                type="password"
                                value={s3Config.secretAccessKey}
                                onChange={(e) => updateS3Field('secretAccessKey', e.target.value)}
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
                                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                                <Wifi className="h-4 w-4 mr-1" />
                            )}
                            Test Connection
                        </Button>

                        {s3CheckResult && (
                            <span
                                className={`text-sm flex items-center gap-1 ${s3CheckResult.ok ? 'text-green-600' : 'text-destructive'}`}
                            >
                                {s3CheckResult.ok ? (
                                    <CheckCircle2 className="h-4 w-4" />
                                ) : (
                                    <AlertTriangle className="h-4 w-4" />
                                )}
                                {s3CheckResult.message}
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
