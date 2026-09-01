import { copyToClipboard } from '@workspace/lib/clipboard';
import {
    S3_ABORT_INCOMPLETE_UPLOAD_DAYS,
    S3_LIFECYCLE_RULE_ID,
    S3_NONCURRENT_DAYS_DEFAULT,
} from '@workspace/lib/constants/s3';
import { isS3ConfigValid } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, CheckCircle2, Copy, Loader2, ShieldCheck, Wifi } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Alert, AlertDescription } from '../alert';
import { Button } from '../button';
import { ConfirmDialog } from '../confirm-dialog';
import { Input } from '../input';
import { Label } from '../label';

type S3ConfigCardProps = {
    value: S3Config;
    onChange: (config: S3Config) => void;
    onCheck: (config: S3Config) => Promise<S3CheckResult>;
    onHarden: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    isEdit?: boolean;
    onCheckResult?: (result: S3CheckResult | null) => void;
};

export function S3ConfigCard({ value, onChange, onCheck, onHarden, isEdit, onCheckResult }: S3ConfigCardProps) {
    const [result, setResult] = useState<S3CheckResult | null>(null);
    const [harden, setHarden] = useState<S3HardenResult | null>(null);
    const [checking, setChecking] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [days, setDays] = useState(S3_NONCURRENT_DAYS_DEFAULT);

    const valid = isS3ConfigValid(value);

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

    const handleHarden = async () => {
        let next: S3HardenResult;
        try {
            next = await onHarden(value, days);
        } catch {
            next = {
                ok: false,
                message: 'Could not update the bucket',
                applied: { versioning: false, lifecycle: false },
                reason: 'error',
            };
        }
        setHarden(next);
        // The harden result carries the re-read bucket state, so the panel flips to what was measured.
        if (next.versioning) {
            setResult((prev) => prev && { ...prev, versioning: next.versioning, lifecycle: next.lifecycle });
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

            {result?.ok && (
                <BucketSafetyPanel
                    config={value}
                    result={result}
                    harden={harden}
                    days={days}
                    onEnable={() => setConfirming(true)}
                />
            )}

            <ConfirmDialog
                open={confirming}
                onOpenChange={setConfirming}
                title="Make this bucket safe for Eigen"
                description={
                    <span className="block space-y-2">
                        <span className="block">
                            Turns on bucket versioning, so overwrites and deletes can be recovered. Versioning applies
                            to the whole bucket.
                        </span>
                        <span className="flex items-center gap-2">
                            Expire old versions after
                            <Input
                                type="number"
                                min={1}
                                className="h-8 w-20"
                                value={days}
                                onChange={(e) => setDays(Math.max(1, e.target.valueAsNumber || 1))}
                            />
                            days
                        </span>
                        <span className="block">
                            Eigen re-uploads whole files on every save, so an often-edited document makes a lot of
                            versions. More days means more to recover from, and more storage used.
                        </span>
                    </span>
                }
                onConfirm={handleHarden}
                confirmText="Enable"
            />
        </div>
    );
}

function BucketSafetyPanel({
    config,
    result,
    harden,
    days,
    onEnable,
}: {
    config: S3Config;
    result: S3CheckResult;
    harden: S3HardenResult | null;
    days: number;
    onEnable: () => void;
}) {
    const { versioning, lifecycle } = result;
    const lifecycleDays = typeof lifecycle === 'object' ? lifecycle.noncurrentDays : null;
    // A key that can't read bucket config can't write it, and a foreign lifecycle config is never
    // rewritten — so the button only shows where a PUT can actually change something.
    const canApply = (versioning !== 'enabled' && versioning !== 'unknown') || lifecycle === 'none';
    const showManualSteps =
        versioning === 'unknown' || lifecycle === 'foreign' || lifecycle === 'unknown' || !!harden?.reason;

    return (
        <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
                <h5 className="text-sm font-medium">Bucket safety</h5>
                {canApply && (
                    <Button type="button" size="sm" onClick={onEnable}>
                        <ShieldCheck className="h-4 w-4 mr-1" />
                        Enable safe defaults
                    </Button>
                )}
            </div>

            <SafetyLine ok={versioning === 'enabled'}>
                {versioning === 'enabled' && 'Versioning: on'}
                {versioning === 'disabled' && 'Versioning: off. Overwrites are permanent.'}
                {versioning === 'suspended' && 'Versioning: suspended. New overwrites are permanent.'}
                {(versioning === 'unknown' || versioning === undefined) &&
                    'Versioning: cannot be read with this access key.'}
            </SafetyLine>

            <SafetyLine ok={lifecycleDays !== null}>
                {lifecycleDays !== null && `Old-version cleanup: expires versions after ${lifecycleDays} days`}
                {lifecycle === 'none' && 'Old-version cleanup: no rule. Old versions grow forever.'}
                {lifecycle === 'foreign' && 'Old-version cleanup: another lifecycle rule is in place.'}
                {(lifecycle === 'unknown' || lifecycle === undefined) &&
                    'Old-version cleanup: cannot be read with this access key.'}
            </SafetyLine>

            {harden && <p className={cn('text-sm', harden.ok ? 'text-success' : 'text-warning')}>{harden.message}</p>}

            {showManualSteps && (
                <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                        Eigen can't change this bucket from here. Apply the same settings in your S3 provider:
                    </p>
                    <pre className="text-xs bg-muted rounded p-2 overflow-x-auto">{manualSnippet(config, days)}</pre>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(manualSnippet(config, days), 'Commands copied to clipboard')}
                    >
                        <Copy className="h-4 w-4 mr-1" />
                        Copy commands
                    </Button>
                </div>
            )}
        </div>
    );
}

function SafetyLine({ ok, children }: { ok: boolean; children: ReactNode }) {
    return (
        <div className={cn('text-sm flex items-center gap-1.5', ok ? 'text-success' : 'text-warning')}>
            {ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
            {children}
        </div>
    );
}

function manualSnippet(config: S3Config, days: number): string {
    const filter = config.prefix ? `{"Prefix":"${config.prefix}/"}` : '{}';
    const rules =
        `{"Rules":[{"ID":"${S3_LIFECYCLE_RULE_ID}","Filter":${filter},"Status":"Enabled",` +
        `"NoncurrentVersionExpiration":{"NoncurrentDays":${days}},` +
        `"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":${S3_ABORT_INCOMPLETE_UPLOAD_DAYS}}}]}`;
    return [
        `aws s3api put-bucket-versioning --endpoint-url ${config.endpoint} --bucket ${config.bucket} \\`,
        '  --versioning-configuration Status=Enabled',
        `aws s3api put-bucket-lifecycle-configuration --endpoint-url ${config.endpoint} --bucket ${config.bucket} \\`,
        `  --lifecycle-configuration '${rules}'`,
    ].join('\n');
}
