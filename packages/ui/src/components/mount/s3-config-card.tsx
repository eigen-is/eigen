// The S3 configuration fields, a button that tests the connection, and after a good test the bucket safety panel and
// its retention dialog. Once its form's Save was pressed, a field the config needs that is empty says so under
// itself. Forms such as the storage and backup settings and the mount dialog use it.

import { S3_NONCURRENT_DAYS_DEFAULT } from '@workspace/lib/constants/s3';
import type { S3Config } from '@workspace/lib/types/mount';
import { missingS3Fields } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, CheckCircle2, Wifi } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription } from '../alert';
import { EigenLoader } from '../braket/eigen-loader';
import { Button } from '../button';
import { Field, FieldError, FieldLabel } from '../field';
import { useFormSubmitted } from '../form-shell';
import { Input } from '../input';
import { BucketSafetyPanel, RetentionDialog } from './bucket-safety';

const S3_FIELDS: { key: keyof S3Config; label: string; placeholder: string; whenMissing?: string }[] = [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.amazonaws.com', whenMissing: 'Add an endpoint' },
    { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket', whenMissing: 'Add a bucket' },
    { key: 'prefix', label: 'Prefix', placeholder: 'optional/path' },
    { key: 'region', label: 'Region', placeholder: 'eu-west-1' },
    { key: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA...', whenMissing: 'Add an access key ID' },
    {
        key: 'secretAccessKey',
        label: 'Secret access key',
        placeholder: 'Enter the secret access key',
        whenMissing: 'Add the secret access key',
    },
];

type S3ConfigCardProps = {
    value: S3Config;
    onChange: (config: S3Config) => void;
    onCheck: (config: S3Config) => Promise<S3CheckResult>;
    // Without it the card has no Bucket safety panel: the backup bucket holds archives, not versioned files.
    onHarden?: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    isEdit?: boolean;
    onCheckResult?: (result: S3CheckResult | null) => void;
    secretSaved?: boolean;
};

export function S3ConfigCard({
    value,
    onChange,
    onCheck,
    onHarden,
    isEdit,
    onCheckResult,
    secretSaved,
}: S3ConfigCardProps) {
    const [result, setResult] = useState<S3CheckResult | null>(null);
    const [harden, setHarden] = useState<S3HardenResult | null>(null);
    const [checking, setChecking] = useState(false);
    const [retentionOpen, setRetentionOpen] = useState(false);
    const [days, setDays] = useState(S3_NONCURRENT_DAYS_DEFAULT);
    const fieldId = useId();
    const submitted = useFormSubmitted();

    const missing = missingS3Fields(value, secretSaved);
    const valid = missing.length === 0;

    const updateField = (field: keyof S3Config, fieldValue: string) => {
        onChange({ ...value, [field]: fieldValue });
        setResult(null);
        setHarden(null);
        onCheckResult?.(null);
    };

    const handleCheck = async () => {
        if (!valid) return;
        setChecking(true);
        setResult(null);
        setHarden(null);
        onCheckResult?.(null);
        try {
            const next = await onCheck(value);
            setResult(next);
            if (typeof next.lifecycle === 'object') setDays(next.lifecycle.noncurrentDays);
            onCheckResult?.(next);
        } catch {
            const fallback: S3CheckResult = { ok: false, message: 'Connection check failed' };
            setResult(fallback);
            onCheckResult?.(fallback);
        } finally {
            setChecking(false);
        }
    };

    // A harden result carries the state read back after the change, so it wins, per field, because it can measure one
    // half and say nothing about the other. A check that never reached the bucket settings reads as unknown.
    const versioning = harden?.versioning ?? result?.versioning ?? 'unknown';
    const lifecycle = harden?.lifecycle ?? result?.lifecycle ?? 'unknown';
    // Opened from the all-green state, the dialog is a retention change and not the first pass.
    const changingRetention = versioning === 'enabled' && typeof lifecycle === 'object';

    return (
        <div className="space-y-3 border rounded-lg p-4">
            <h4 className="text-sm font-medium">S3 configuration</h4>

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
                {S3_FIELDS.map(({ key, label, placeholder, whenMissing }) => {
                    const refused = submitted && missing.includes(key);
                    return (
                        <Field key={key}>
                            <FieldLabel htmlFor={`${fieldId}-${key}`}>{label}</FieldLabel>
                            <Input
                                id={`${fieldId}-${key}`}
                                aria-invalid={refused || undefined}
                                aria-describedby={refused ? `${fieldId}-${key}-error` : undefined}
                                type={key === 'secretAccessKey' ? 'password' : undefined}
                                value={value[key] ?? ''}
                                onChange={(e) => updateField(key, e.target.value)}
                                placeholder={
                                    key === 'secretAccessKey' && secretSaved
                                        ? 'Saved. Leave empty to keep it'
                                        : placeholder
                                }
                            />
                            {refused && <FieldError id={`${fieldId}-${key}-error`}>{whenMissing}</FieldError>}
                        </Field>
                    );
                })}
            </div>

            <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={handleCheck} disabled={!valid || checking}>
                    {checking ? <EigenLoader className="mr-1 text-current" /> : <Wifi className="h-4 w-4 mr-1" />}
                    Test connection
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

            {result?.warning && (
                <p className="text-sm text-warning flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {result.warning}
                </p>
            )}

            {result?.ok && onHarden && (
                <BucketSafetyPanel
                    config={value}
                    versioning={versioning}
                    lifecycle={lifecycle}
                    harden={harden}
                    days={days}
                    onEnable={() => setRetentionOpen(true)}
                />
            )}

            {onHarden && (
                <RetentionDialog
                    open={retentionOpen}
                    onOpenChange={setRetentionOpen}
                    changingRetention={changingRetention}
                    initialDays={days}
                    onSubmit={async (nextDays) => {
                        // A refused request comes back as an ok:false result, so there is nothing to catch here.
                        setHarden(await onHarden(value, nextDays));
                        setDays(nextDays);
                    }}
                />
            )}
        </div>
    );
}
