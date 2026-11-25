// The bucket safety panel under a tested S3 config: whether the bucket keeps old versions of files and cleans them up,
// with the aws commands for a bucket Eigen may not change. Where Eigen may change it, the panel opens the retention
// dialog, which turns versioning on and sets how many days old versions are kept. S3ConfigCard shows both.

import {
    S3_ABORT_INCOMPLETE_UPLOAD_DAYS,
    S3_LIFECYCLE_RULE_ID,
    S3_NONCURRENT_DAYS_MAX,
} from '@workspace/lib/constants/s3';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3HardenResult, S3LifecycleState, S3VersioningState } from '@workspace/lib/types/settings';
import { cn } from '@workspace/ui/lib/utils';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../button';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from '../code-block';
import { Field, FieldDescription, FieldLabel } from '../field';
import { FormDialog, FormDialogForm } from '../form-dialog';
import { Input } from '../input';

export function BucketSafetyPanel({
    config,
    versioning,
    lifecycle,
    harden,
    days,
    onEnable,
}: {
    config: S3Config;
    versioning: S3VersioningState;
    lifecycle: S3LifecycleState;
    harden: S3HardenResult | null;
    days: number;
    onEnable: () => void;
}) {
    const lifecycleDays = typeof lifecycle === 'object' ? lifecycle.noncurrentDays : null;
    // A key that can't read the bucket settings can't write them either, and Eigen never rewrites a lifecycle
    // config it didn't write. So the button only shows where a PUT can change something.
    const canApply = versioning !== 'unknown' && (versioning !== 'enabled' || lifecycle === 'none');
    const showManualSteps =
        versioning === 'unknown' || lifecycle === 'foreign' || lifecycle === 'unknown' || !!harden?.reason;

    return (
        <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
                <h5 className="text-sm font-medium">Bucket safety</h5>
                {canApply && (
                    <Button size="sm" onClick={onEnable}>
                        <ShieldCheck className="h-4 w-4 mr-1" />
                        Enable safe defaults
                    </Button>
                )}
            </div>

            <SafetyLine ok={versioning === 'enabled'}>
                {versioning === 'enabled' && 'Versioning: on'}
                {versioning === 'disabled' && 'Versioning: off. Overwrites are permanent.'}
                {versioning === 'suspended' && 'Versioning: suspended. New overwrites are permanent.'}
                {versioning === 'unknown' && 'Versioning: cannot be read with this access key.'}
            </SafetyLine>

            <SafetyLine ok={lifecycleDays !== null}>
                {lifecycleDays !== null && `Old-version cleanup: expires versions after ${lifecycleDays} days`}
                {lifecycle === 'none' && 'Old-version cleanup: no rule. Old versions grow forever.'}
                {lifecycle === 'foreign' && 'Old-version cleanup: another lifecycle rule is in place.'}
                {lifecycle === 'unknown' && 'Old-version cleanup: cannot be read with this access key.'}
                {/* All green, so there is no button. This link is the only way back to the days field. */}
                {versioning === 'enabled' && lifecycleDays !== null && (
                    <button type="button" className="underline hover:text-foreground" onClick={onEnable}>
                        Change
                    </button>
                )}
            </SafetyLine>

            {harden && <p className={cn('text-sm', harden.ok ? 'text-success' : 'text-warning')}>{harden.message}</p>}

            {showManualSteps && (
                <ManualSteps config={config} days={days} versioning={versioning} lifecycle={lifecycle} />
            )}
        </div>
    );
}

// What the button would have done, as aws CLI commands. They are for the buckets Eigen may not change from here,
// and a reference once everything is set.
function ManualSteps({
    config,
    days,
    versioning,
    lifecycle,
}: {
    config: S3Config;
    days: number;
    versioning: S3VersioningState;
    lifecycle: S3LifecycleState;
}) {
    const needVersioning = versioning !== 'enabled';
    const needLifecycle = typeof lifecycle !== 'object';
    const nothingLeft = !needVersioning && !needLifecycle;

    let intro: string;
    if (nothingLeft) {
        intro = 'The same settings by hand, for a key without bucket-settings permission:';
    } else if (needVersioning && needLifecycle) {
        intro = "Eigen can't change this bucket from here. Apply these settings in your S3 provider:";
    } else if (needLifecycle) {
        intro = 'Versioning is on. The old-version cleanup rule still has to be set in your S3 provider:';
    } else {
        intro = 'Old-version cleanup is set. Versioning still has to be turned on in your S3 provider:';
    }

    const commands = manualSnippet(config, days, {
        versioning: needVersioning || nothingLeft,
        lifecycle: needLifecycle || nothingLeft,
    });

    return (
        <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{intro}</p>
            {lifecycle === 'foreign' && (
                <p className="text-sm text-muted-foreground">
                    This command replaces the bucket's whole lifecycle configuration, so add the rules that are already
                    there to it first.
                </p>
            )}
            <CodeBlock size="sm">
                <CodeBlockActions>
                    <CodeBlockCopyButton value={commands} />
                </CodeBlockActions>
                <CodeBlockContent>{commands}</CodeBlockContent>
            </CodeBlock>
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

// Single-quote a value for the shell: this text is meant to be pasted into a terminal, and a bucket
// name or prefix is user input.
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function manualSnippet(config: S3Config, days: number, include: { versioning: boolean; lifecycle: boolean }): string {
    const rules = {
        Rules: [
            {
                ID: S3_LIFECYCLE_RULE_ID,
                Filter: config.prefix ? { Prefix: `${config.prefix}/` } : {},
                Status: 'Enabled',
                NoncurrentVersionExpiration: { NoncurrentDays: days },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: S3_ABORT_INCOMPLETE_UPLOAD_DAYS },
            },
        ],
    };
    const target = `--endpoint-url ${shellQuote(config.endpoint)} --bucket ${shellQuote(config.bucket)}`;
    const lines: string[] = [];
    if (include.versioning) {
        lines.push(`aws s3api put-bucket-versioning ${target} \\`, '  --versioning-configuration Status=Enabled');
    }
    if (include.lifecycle) {
        lines.push(
            `aws s3api put-bucket-lifecycle-configuration ${target} \\`,
            `  --lifecycle-configuration ${shellQuote(JSON.stringify(rules))}`,
        );
    }
    return lines.join('\n');
}

export function RetentionDialog({
    open,
    onOpenChange,
    changingRetention,
    initialDays,
    onSubmit,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // From the all-green state, the dialog changes the retention rather than making the bucket safe.
    changingRetention: boolean;
    initialDays: number;
    onSubmit: (days: number) => Promise<void>;
}) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={changingRetention ? 'Change retention' : 'Make this bucket safe for Eigen'}
        >
            <RetentionForm initialDays={initialDays} changingRetention={changingRetention} onSubmit={onSubmit} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from the card's days, and Cancel leaves them as they were.
function RetentionForm({
    initialDays,
    changingRetention,
    onSubmit,
}: {
    initialDays: number;
    changingRetention: boolean;
    onSubmit: (days: number) => Promise<void>;
}) {
    const [days, setDays] = useState(initialDays);

    return (
        <FormDialogForm submitLabel={changingRetention ? 'Update' : 'Enable'} onSubmit={() => onSubmit(days)}>
            {!changingRetention && (
                <p className="text-sm text-muted-foreground">
                    Turns on bucket versioning, so overwrites and deletes can be recovered. Versioning applies to the
                    whole bucket.
                </p>
            )}
            <Field>
                <FieldLabel className="font-normal">
                    Expire old versions after
                    <Input
                        type="number"
                        min={1}
                        max={S3_NONCURRENT_DAYS_MAX}
                        step={1}
                        className="h-8 w-20"
                        value={days}
                        onChange={(e) => setDays(clampDays(e.target.valueAsNumber))}
                    />
                    days
                </FieldLabel>
                <FieldDescription>
                    Eigen re-uploads whole files on every save, so an often-edited document makes a lot of versions.
                    More days means more to recover from, and more storage used.
                </FieldDescription>
            </Field>
        </FormDialogForm>
    );
}

// The rule takes whole days, and the route's schema refuses anything else, so the field stays in range.
function clampDays(value: number): number {
    return Math.min(S3_NONCURRENT_DAYS_MAX, Math.max(1, Math.round(value) || 1));
}
