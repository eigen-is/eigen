import {
    useBackupArtifacts,
    useBackupJobs,
    useDeleteBackupArtifact,
    useDeleteSafetyCopy,
    useRestoreBackup,
    useStartBackup,
    useUploadBackup,
    useVerifyBackup,
} from '@workspace/lib/admin';
import { getBackupArtifactUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { DeleteDialog, EmptyState, ErrorState, LoadingState, TooltipButton } from '@workspace/ui';
import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Progress } from '@workspace/ui/components/progress';
import { Archive, Download, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

const JOB_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Creating backup',
    verify: 'Verifying archive',
    restore: 'Restoring home',
};

function VerifyBadge({ artifact }: { artifact: BackupArtifact }) {
    if (artifact.verify.status === 'verified') return <Badge variant="secondary">verified</Badge>;
    if (artifact.verify.status === 'failed') return <Badge variant="destructive">failed</Badge>;
    return <Badge variant="outline">unverified</Badge>;
}

type Pending =
    | { kind: 'restore'; name: string }
    | { kind: 'artifact'; name: string }
    | { kind: 'safety'; name: string };

type BackupSectionProps = {
    ownerId: string;
};

// The backup pane of one home, in the admin user and team detail panes. Guests never reach it: the
// admin user list excludes them and guest homes have their own route.
export function BackupSection({ ownerId }: BackupSectionProps) {
    const [pending, setPending] = useState<Pending | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    const { data, isLoading, isError } = useBackupArtifacts(ownerId);
    const { data: jobs = [] } = useBackupJobs(ownerId);
    const startBackup = useStartBackup(ownerId);
    const uploadBackup = useUploadBackup(ownerId);
    const verifyBackup = useVerifyBackup(ownerId);
    const restoreBackup = useRestoreBackup(ownerId);
    const deleteArtifact = useDeleteBackupArtifact(ownerId);
    const deleteSafetyCopy = useDeleteSafetyCopy(ownerId);

    // Newest first, and the server allows one job per home — so the newest job is the whole story.
    const latest = jobs[0];
    const running = latest?.state === 'running' ? latest : undefined;

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) uploadBackup.mutate(file);
    };

    const confirmProps = () => {
        if (pending?.kind === 'restore') {
            return {
                title: 'Restore this home',
                description:
                    'Every file, mail and database of this home is replaced by the archive. The home is unavailable for the duration, open editors reload, and the current home is kept beside it as a safety copy. Restore',
                itemName: ownerId,
                deleteText: 'Restore',
                onDelete: async () => {
                    await restoreBackup.mutateAsync(pending.name);
                },
            };
        }
        if (pending?.kind === 'artifact') {
            return {
                title: 'Delete backup',
                description: 'Permanently delete the archive',
                itemName: pending.name,
                deleteText: 'Delete',
                onDelete: async () => {
                    await deleteArtifact.mutateAsync(pending.name);
                },
            };
        }
        return {
            title: 'Delete safety copy',
            description: 'This is the only copy of the home as it was before the restore. Permanently delete',
            itemName: pending?.name ?? '',
            deleteText: 'Delete',
            onDelete: async () => {
                await deleteSafetyCopy.mutateAsync(pending?.name ?? '');
            },
        };
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Backup</h3>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!running || startBackup.isPending}
                        onClick={() => startBackup.mutate()}
                    >
                        <Archive className="h-4 w-4 mr-1" />
                        Create backup
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!running || uploadBackup.isPending}
                        onClick={() => fileInput.current?.click()}
                    >
                        <Upload className="h-4 w-4 mr-1" />
                        Upload backup
                    </Button>
                    <input ref={fileInput} type="file" accept=".zst" className="hidden" onChange={handleUpload} />
                </div>
            </div>

            <Alert variant="warning">
                <AlertDescription>
                    An archive holds everything in this home — files, mail, calendars and the stored storage
                    credentials. Treat it as a secret.
                </AlertDescription>
            </Alert>

            {running && (
                <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                        {JOB_LABEL[running.kind]} · {running.progress.step}
                        {running.progress.total > 0 && ` (${running.progress.done}/${running.progress.total})`}
                    </p>
                    {running.progress.total > 0 && (
                        <Progress value={(running.progress.done / running.progress.total) * 100} />
                    )}
                </div>
            )}
            {latest?.state === 'failed' && (
                <p className="text-xs text-destructive">
                    {JOB_LABEL[latest.kind]} failed: {latest.error}
                </p>
            )}

            {isLoading ? (
                <LoadingState />
            ) : isError ? (
                <ErrorState message="Could not load the backups of this home." />
            ) : data?.artifacts.length === 0 ? (
                <EmptyState
                    message="No backups yet"
                    hint="Create one, or copy an archive into the server's backups folder."
                />
            ) : (
                <div className="space-y-2">
                    {data?.artifacts.map((artifact) => (
                        <ArtifactRow
                            key={artifact.name}
                            artifact={artifact}
                            busy={!!running}
                            onVerify={() => verifyBackup.mutate(artifact.name)}
                            onRestore={() => setPending({ kind: 'restore', name: artifact.name })}
                            onDelete={() => setPending({ kind: 'artifact', name: artifact.name })}
                        />
                    ))}
                </div>
            )}

            {!!data?.safetyCopies.length && (
                <div className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Safety copies</h4>
                    {data.safetyCopies.map((copy) => (
                        <SafetyCopyRow
                            key={copy.name}
                            copy={copy}
                            busy={!!running}
                            onDelete={() => setPending({ kind: 'safety', name: copy.name })}
                        />
                    ))}
                </div>
            )}

            <DeleteDialog
                open={!!pending}
                onOpenChange={(open) => {
                    if (!open) setPending(null);
                }}
                {...confirmProps()}
            />
        </div>
    );
}

type ArtifactRowProps = {
    artifact: BackupArtifact;
    busy: boolean;
    onVerify: () => void;
    onRestore: () => void;
    onDelete: () => void;
};

function ArtifactRow({ artifact, busy, onVerify, onRestore, onDelete }: ArtifactRowProps) {
    return (
        <div className="group flex flex-col gap-1 p-3 border rounded-lg">
            <div className="flex items-center gap-3">
                <Archive className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{formatDateTime(artifact.createdAt)}</div>
                    <div className="text-xs text-muted-foreground truncate">
                        {formatFileSize(artifact.bytes)} · {artifact.name}
                    </div>
                </div>
                <VerifyBadge artifact={artifact} />
                <div className="flex items-center invisible group-hover:visible pointer-coarse:visible">
                    <TooltipButton
                        icon={Download}
                        tooltipText="Download"
                        className="h-7 w-7"
                        onClick={() => window.open(getBackupArtifactUrl(artifact.name), '_blank')}
                    />
                    <TooltipButton
                        icon={ShieldCheck}
                        tooltipText="Verify"
                        className="h-7 w-7"
                        disabled={busy}
                        onClick={onVerify}
                    />
                    {/* An archive that failed its verify is not offered for restore — the failures below say why. */}
                    {artifact.verify.status !== 'failed' && (
                        <TooltipButton
                            icon={RotateCcw}
                            tooltipText="Restore"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={onRestore}
                        />
                    )}
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        className="h-7 w-7"
                        disabled={busy}
                        onClick={onDelete}
                    />
                </div>
            </div>
            {artifact.verify.status === 'failed' && (
                <ul className="text-xs text-destructive max-h-24 overflow-y-auto pl-7 list-disc">
                    {artifact.verify.failures.map((failure) => (
                        <li key={failure}>{failure}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

type SafetyCopyRowProps = {
    copy: BackupSafetyCopy;
    busy: boolean;
    onDelete: () => void;
};

function SafetyCopyRow({ copy, busy, onDelete }: SafetyCopyRowProps) {
    return (
        <div className="group flex items-center gap-3 p-3 border rounded-lg">
            <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{formatDateTime(copy.createdAt)}</div>
                <div className="text-xs text-muted-foreground truncate">
                    {copy.kind} · {formatFileSize(copy.bytes)}
                </div>
            </div>
            <div className="invisible group-hover:visible pointer-coarse:visible">
                <TooltipButton
                    icon={Trash2}
                    tooltipText="Delete safety copy"
                    className="h-7 w-7"
                    disabled={busy}
                    onClick={onDelete}
                />
            </div>
        </div>
    );
}
