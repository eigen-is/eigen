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
import { DeleteDialog, EmptyState, ErrorState, LoadingState, TooltipButton } from '@workspace/ui';
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

function VerifyBadge({ artifact }: { artifact: BackupArtifact }) {
    if (artifact.verify.status === 'verified') return <Badge variant="secondary">verified</Badge>;
    if (artifact.verify.status === 'failed') return <Badge variant="destructive">failed</Badge>;
    return <Badge variant="outline">unverified</Badge>;
}

type BackupSectionProps = {
    ownerId: string;
};

// The backup pane of one home, in the admin user and team detail panes. Guests never reach it: the
// admin user list excludes them and guest homes have their own route.
export function BackupSection({ ownerId }: BackupSectionProps) {
    const [restoreArtifact, setRestoreArtifact] = useState<string | null>(null);
    const [deleteArtifactName, setDeleteArtifactName] = useState<string | null>(null);
    const [restoreCopy, setRestoreCopy] = useState<string | null>(null);
    const [deleteCopyName, setDeleteCopyName] = useState<string | null>(null);
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
    const nothingStored = data && data.artifacts.length === 0 && data.safetyCopies.length === 0;

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

            <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                    An archive holds everything in this home — files, mail, calendars and the stored storage
                    credentials. It is a secret; keep it somewhere safe.
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
            {jobsFailed && <p className="text-xs text-destructive">Could not load the jobs running for this home.</p>}

            {isLoading ? (
                <LoadingState />
            ) : isError ? (
                <ErrorState message="Could not load the backups of this home." />
            ) : nothingStored ? (
                <EmptyState
                    icon={<Archive className="h-6 w-6" />}
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
                            onRestore={() => setRestoreArtifact(artifact.name)}
                            onDelete={() => setDeleteArtifactName(artifact.name)}
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
                            onRestore={() => setRestoreCopy(copy.name)}
                            onDelete={() => setDeleteCopyName(copy.name)}
                        />
                    ))}
                </div>
            )}

            {restoreArtifact && (
                <DeleteDialog
                    open
                    onOpenChange={() => setRestoreArtifact(null)}
                    title="Restore this home"
                    description="This replaces every file, mail and database of the home with the archive. The home is unavailable while the restore runs and open editors reload, and the state it is in now is kept beside it as a safety copy. Restore the home of"
                    itemName={ownerId}
                    deleteText="Restore"
                    onDelete={async () => {
                        await restoreBackup.mutateAsync(restoreArtifact);
                    }}
                />
            )}
            {deleteArtifactName && (
                <DeleteDialog
                    open
                    onOpenChange={() => setDeleteArtifactName(null)}
                    title="Delete backup"
                    description="Permanently delete the archive"
                    itemName={deleteArtifactName}
                    onDelete={async () => {
                        await deleteArtifact.mutateAsync(deleteArtifactName);
                    }}
                />
            )}
            {restoreCopy && (
                <DeleteDialog
                    open
                    onOpenChange={() => setRestoreCopy(null)}
                    title="Restore this safety copy"
                    description="The home goes back to the state this copy holds, and the state it is in now becomes a new safety copy beside it. Drive files on a remote mount are restored from the copy's own bucket objects. Restore the copy"
                    itemName={restoreCopy}
                    deleteText="Restore"
                    onDelete={async () => {
                        await restoreSafetyCopy.mutateAsync(restoreCopy);
                    }}
                />
            )}
            {deleteCopyName && (
                <DeleteDialog
                    open
                    onOpenChange={() => setDeleteCopyName(null)}
                    title="Delete safety copy"
                    description="A safety copy is the only record of the home as it was at that moment, and on a remote mount its own bucket objects are deleted with it. Permanently delete"
                    itemName={deleteCopyName}
                    onDelete={async () => {
                        await deleteSafetyCopy.mutateAsync(deleteCopyName);
                    }}
                />
            )}
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
                    {copy.kind} · {formatFileSize(copy.bytes)}
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
