import {
    useBackupArtifacts,
    useBackupJobs,
    useDeleteBackupArtifact,
    useDeleteSafetyCopy,
    useRestoreBackup,
    useRestoreSafetyCopy,
    useStartBackup,
    useUploadBackup,
    useVerifyBackup,
} from '@workspace/lib/admin';
import { getBackupArtifactUrl } from '@workspace/lib/api';
import { formatDateTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupArtifact, BackupJob, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { BACKUP_ARTIFACT_EXTENSION } from '@workspace/lib/validation';
import { DeleteDialog, ErrorState, LoadingState, TooltipButton } from '@workspace/ui';
import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Progress } from '@workspace/ui/components/progress';
import { AlertTriangle, Archive, Download, RotateCcw, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';

const JOB_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Creating backup',
    verify: 'Verifying archive',
    restore: 'Restoring home',
};

const JOB_DONE_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Backup created',
    verify: 'Archive verified',
    restore: 'Home restored',
};

// The two things a row shows about itself are server words; these are the ones an admin reads.
const VERIFY_LABEL: Record<BackupArtifact['verify']['status'], string> = {
    verified: 'Verified',
    failed: 'Failed',
    unverified: 'Not verified',
};

const SAFETY_COPY_LABEL: Record<BackupSafetyCopy['kind'], string> = {
    'pre-restore': 'The home before a restore',
    'failed-restore': 'A restore that did not finish',
};

function VerifyBadge({ artifact }: { artifact: BackupArtifact }) {
    const label = VERIFY_LABEL[artifact.verify.status];
    if (artifact.verify.status === 'verified') return <Badge variant="secondary">{label}</Badge>;
    if (artifact.verify.status === 'failed') return <Badge variant="destructive">{label}</Badge>;
    return <Badge variant="outline">{label}</Badge>;
}

// The four confirmations this pane asks for. One dialog is mounted for all of them — a dialog that
// unmounts on close skips its own closing animation — and the choice keeps its name and kind until
// the next one replaces it.
type BackupConfirm =
    | { kind: 'restore-artifact'; name: string }
    | { kind: 'delete-artifact'; name: string }
    | { kind: 'restore-copy'; name: string }
    | { kind: 'delete-copy'; name: string };

const CONFIRM_COPY: Record<BackupConfirm['kind'], { title: string; description: string; action: string }> = {
    'restore-artifact': {
        title: 'Restore this home',
        description:
            'This replaces every file, mail and database of the home with the archive. The home is unavailable while the restore runs and open editors reload, and the state it is in now is kept beside it as a safety copy. Restore the home of',
        action: 'Restore',
    },
    'delete-artifact': {
        title: 'Delete backup',
        description: 'Permanently delete the archive',
        action: 'Delete',
    },
    'restore-copy': {
        title: 'Restore this safety copy',
        description:
            "The home goes back to the state this copy holds, and the state it is in now becomes a new safety copy beside it. Drive files on a remote mount are restored from the copy's own bucket objects. Restore the copy",
        action: 'Restore',
    },
    'delete-copy': {
        title: 'Delete safety copy',
        description:
            'A safety copy is the only record of the home as it was at that moment, and on a remote mount its own bucket objects are deleted with it. Permanently delete',
        action: 'Delete',
    },
};

type BackupSectionProps = {
    ownerId: string;
};

// The backup pane of one home, in the admin user and team detail panes. Guests never reach it: the
// admin user list excludes them and guest homes have their own route.
export function BackupSection({ ownerId }: BackupSectionProps) {
    const [confirm, setConfirm] = useState<BackupConfirm | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    const { data, isLoading, isError } = useBackupArtifacts(ownerId);
    const { data: jobs = [], isError: jobsFailed } = useBackupJobs(ownerId);
    const startBackup = useStartBackup(ownerId);
    const uploadBackup = useUploadBackup();
    const verifyBackup = useVerifyBackup(ownerId);
    const restoreBackup = useRestoreBackup(ownerId);
    const restoreSafetyCopy = useRestoreSafetyCopy(ownerId);
    const deleteArtifact = useDeleteBackupArtifact(ownerId);
    const deleteSafetyCopy = useDeleteSafetyCopy(ownerId);

    // Newest first, and the server allows one job per home — so the newest job is the whole story.
    const latest = jobs[0];
    const running = latest?.state === 'running' ? latest : undefined;
    const failed = latest?.state === 'failed' && latest.id !== dismissedJobId ? latest : undefined;
    const finished = latest?.state === 'done' && latest.id !== dismissedJobId ? latest : undefined;

    const ask = (next: BackupConfirm) => {
        setConfirm(next);
        setConfirmOpen(true);
    };

    const runConfirmed = async () => {
        if (!confirm) return;
        if (confirm.kind === 'restore-artifact') await restoreBackup.mutateAsync(confirm.name);
        else if (confirm.kind === 'delete-artifact') await deleteArtifact.mutateAsync(confirm.name);
        else if (confirm.kind === 'restore-copy') await restoreSafetyCopy.mutateAsync(confirm.name);
        else await deleteSafetyCopy.mutateAsync(confirm.name);
    };

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) uploadBackup.mutate(file);
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">Backup</h3>
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
                    <input
                        ref={fileInput}
                        type="file"
                        accept={BACKUP_ARTIFACT_EXTENSION}
                        className="hidden"
                        onChange={handleUpload}
                    />
                </div>
            </div>

            {data && data.artifacts.length + data.safetyCopies.length > 0 && (
                <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        An archive holds everything in this home — files, mail, calendars and the stored storage
                        credentials. It is a secret; keep it somewhere safe.
                    </AlertDescription>
                </Alert>
            )}

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
            {failed && (
                <div className="flex items-start gap-1">
                    <p className="text-xs text-destructive flex-1">
                        {JOB_LABEL[failed.kind]} failed: {failed.error}
                    </p>
                    <TooltipButton
                        icon={X}
                        tooltipText="Dismiss"
                        className="h-5 w-5 shrink-0"
                        onClick={() => setDismissedJobId(failed.id)}
                    />
                </div>
            )}
            {finished && (
                <div className="flex items-start gap-1">
                    <p className="text-xs text-muted-foreground flex-1 truncate">
                        {JOB_DONE_LABEL[finished.kind]}
                        {finished.artifact && ` · ${finished.artifact}`}
                    </p>
                    <TooltipButton
                        icon={X}
                        tooltipText="Dismiss"
                        className="h-5 w-5 shrink-0"
                        onClick={() => setDismissedJobId(finished.id)}
                    />
                </div>
            )}
            {jobsFailed && <p className="text-xs text-destructive">Could not load the jobs running for this home.</p>}

            {isLoading ? (
                <LoadingState />
            ) : isError || !data ? (
                <ErrorState message="Could not load the backups of this home." />
            ) : data.artifacts.length + data.safetyCopies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No backups yet.</p>
            ) : (
                // Both lists in one branch: the empty state above stands for the whole section, and
                // a home with no archive can still have a safety copy beside it.
                <div className="space-y-2">
                    {data.artifacts.map((artifact) => (
                        <ArtifactRow
                            key={artifact.name}
                            artifact={artifact}
                            busy={!!running}
                            onVerify={() => verifyBackup.mutate(artifact.name)}
                            onRestore={() => ask({ kind: 'restore-artifact', name: artifact.name })}
                            onDelete={() => ask({ kind: 'delete-artifact', name: artifact.name })}
                        />
                    ))}
                    {data.safetyCopies.length > 0 && (
                        <div className="space-y-2 pt-1">
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                Safety copies
                            </h4>
                            {data.safetyCopies.map((copy) => (
                                <SafetyCopyRow
                                    key={copy.name}
                                    copy={copy}
                                    busy={!!running}
                                    onRestore={() => ask({ kind: 'restore-copy', name: copy.name })}
                                    onDelete={() => ask({ kind: 'delete-copy', name: copy.name })}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            <DeleteDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={confirm ? CONFIRM_COPY[confirm.kind].title : ''}
                description={confirm ? CONFIRM_COPY[confirm.kind].description : ''}
                // A restore of the whole home is confirmed against the home, not against the file it
                // is being restored from.
                itemName={confirm?.kind === 'restore-artifact' ? ownerId : confirm?.name}
                deleteText={confirm ? CONFIRM_COPY[confirm.kind].action : undefined}
                onDelete={runConfirmed}
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
    // A mount the home had turned off whose storage could not be read: the archive holds nothing for
    // it, and the row says so rather than letting the admin assume it is in there.
    const skipped = artifact.manifest?.mounts.filter((mount) => mount.skipped) ?? [];
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
            {skipped.map((mount) => (
                <p key={mount.id} className="text-xs text-muted-foreground pl-7 truncate">
                    Skipped mount {mount.id}: {mount.skipped}
                </p>
            ))}
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
    onRestore: () => void;
    onDelete: () => void;
};

function SafetyCopyRow({ copy, busy, onRestore, onDelete }: SafetyCopyRowProps) {
    return (
        <div className="group flex items-center gap-3 p-3 border rounded-lg">
            <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{formatDateTime(copy.createdAt)}</div>
                <div className="text-xs text-muted-foreground truncate">
                    {/* Measuring a whole home stops after a cap, so the number is a floor. Saying so
                        beats showing 52 MB for a 284 MB copy. */}
                    {SAFETY_COPY_LABEL[copy.kind]} · {copy.truncated ? 'at least ' : ''}
                    {formatFileSize(copy.bytes)}
                </div>
            </div>
            <div className="flex items-center invisible group-hover:visible pointer-coarse:visible">
                {/* Only a pre-restore copy is a home this can put back; a failed-restore folder is a
                    half-written one, which the route refuses. */}
                {copy.kind === 'pre-restore' && (
                    <TooltipButton
                        icon={RotateCcw}
                        tooltipText="Restore this copy"
                        className="h-7 w-7"
                        disabled={busy}
                        onClick={onRestore}
                    />
                )}
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
