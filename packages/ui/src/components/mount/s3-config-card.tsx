import { isS3ConfigValid } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult } from '@workspace/lib/types/settings';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, CheckCircle2, Loader2, Wifi } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '../alert';
import { Button } from '../button';
import { Input } from '../input';
import { Label } from '../label';

type S3ConfigCardProps = {
    value: S3Config;
    onChange: (config: S3Config) => void;
    onCheck: (config: S3Config) => Promise<S3CheckResult>;
    isEdit?: boolean;
    onCheckResult?: (result: S3CheckResult | null) => void;
};

export function S3ConfigCard({ value, onChange, onCheck, isEdit, onCheckResult }: S3ConfigCardProps) {
    const [result, setResult] = useState<S3CheckResult | null>(null);
    const [checking, setChecking] = useState(false);

    const valid = isS3ConfigValid(value);

    const updateField = (field: keyof S3Config, fieldValue: string) => {
        onChange({ ...value, [field]: fieldValue });
        setResult(null);
        onCheckResult?.(null);
    };

    const handleCheck = async () => {
        if (!valid) return;
        setChecking(true);
        setResult(null);
        onCheckResult?.(null);
        try {
            const next = await onCheck(value);
            setResult(next);
            onCheckResult?.(next);
        } catch {
            const fallback: S3CheckResult = { ok: false, message: 'Connection check failed' };
            setResult(fallback);
            onCheckResult?.(fallback);
        } finally {
            setChecking(false);
        }
    };

    return (
        <div className="space-y-3 border rounded-lg p-4">
            <h4 className="text-sm font-medium">S3 Configuration</h4>

            {isEdit && (
                <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        Changing S3 settings on an existing mount can break access to stored files. Test the connection
                        before saving.
                    </AlertDescription>
                </Alert>
            )}

            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label>Endpoint</Label>
                    <Input
                        value={value.endpoint}
                        onChange={(e) => updateField('endpoint', e.target.value)}
                        placeholder="https://s3.amazonaws.com"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Bucket</Label>
                    <Input
                        value={value.bucket}
                        onChange={(e) => updateField('bucket', e.target.value)}
                        placeholder="my-bucket"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Prefix</Label>
                    <Input
                        value={value.prefix}
                        onChange={(e) => updateField('prefix', e.target.value)}
                        placeholder="optional/path"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Region</Label>
                    <Input
                        value={value.region ?? ''}
                        onChange={(e) => updateField('region', e.target.value)}
                        placeholder="eu-west-1"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Access Key ID</Label>
                    <Input
                        value={value.accessKeyId}
                        onChange={(e) => updateField('accessKeyId', e.target.value)}
                        placeholder="AKIA..."
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Secret Access Key</Label>
                    <Input
                        type="password"
                        value={value.secretAccessKey}
                        onChange={(e) => updateField('secretAccessKey', e.target.value)}
                        placeholder="••••••••"
                    />
                </div>
            </div>

            <div className="flex items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={handleCheck} disabled={!valid || checking}>
                    {checking ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wifi className="h-4 w-4 mr-1" />}
                    Test Connection
                </Button>

                {result && (
                    <span
                        className={cn(
                            'text-sm flex items-center gap-1',
                            result.ok ? 'text-success' : 'text-destructive',
                        )}
                    >
                        {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                        {result.message}
                    </span>
                )}
            </div>

            {result?.ok && (result.versioning === 'disabled' || result.versioning === 'suspended') && (
                <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        Bucket versioning is <strong>{result.versioning === 'suspended' ? 'suspended' : 'off'}</strong>.
                        Without it, accidental overwrites of database files (e.g. chat or document <code>data.db</code>)
                        are permanent. Enable bucket versioning and a noncurrent-version lifecycle policy in your S3
                        provider.
                    </AlertDescription>
                </Alert>
            )}
        </div>
    );
}
