// The Backup section of one home in the Admin app's user and team details: its archives and safety
// copies, the job that runs now, and the buttons that back up, verify, restore and delete, and for the owner upload.
// Guests never reach it: the admin user list leaves them out and guest homes have their own route.

import {
    useBackupArtifacts,
    useBackupJobs,
    useDeleteBackupArtifact,
    useDeleteSafetyCopy,
    useIsOrgOwner,
    useRestoreBackup,
    useRestoreSafetyCopy,
    useStartBackup,
    useUploadBackup,
    useVerifyBackup,
} from '@workspace/lib/admin';
import { getBackupArtifactUrl } from '@workspace/lib/api';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupArtifact, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { BACKUP_ARTIFACT_EXTENSION, incompleteReason } from '@workspace/lib/validation';
import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { AlertTriangle, Archive, Download, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { BackupArtifactRow, VerifyBadge, VerifyFailures, VerifyLines } from './backup-artifact-row';
import { BackupJobStatus } from './backup-job-status';

const SAFETY_COPY_LABEL: Record<BackupSafetyCopy['kind'], string> = {
    'pre-restore': 'The account before a restore',
    'failed-restore': 'A restore that did not finish',
};

type ConfirmTarget = { name: string; ownerId: string };

// The four confirmations this pane asks for, one dialog for all of them. Each names what it acts on: a restore of
// the whole account names the account, the others the archive or copy.
const CONFIRM_COPY = {
    'restore-artifact': {
        title: 'Restore this account',
        description: ({ ownerId }: ConfirmTarget) => (
            <>
                Restore the account of <strong>{ownerId}</strong>? This replaces every file, mail and database of the
                account with the archive. The account is unavailable while the restore runs, every open page of it
                reloads, and the state it is in now is kept beside it as a safety copy.
            </>
        ),
        action: 'Restore',
    },
    'delete-artifact': {
        title: 'Delete backup',
        description: ({ name }: ConfirmTarget) => (
            <>
                Permanently delete the archive <strong>{name}</strong>?
            </>
        ),
        action: 'Delete',
    },
    'restore-copy': {
        title: 'Restore this safety copy',
        description: ({ name }: ConfirmTarget) => (
            <>
                Restore the copy <strong>{name}</strong>? The account goes back to the state this copy holds, and the
                state it is in now becomes a new safety copy beside it. Drive files on a remote mount are restored from
                the copy's own bucket objects.
            </>
        ),
        action: 'Restore',
    },
    'delete-copy': {
        title: 'Delete safety copy',
        description: ({ name }: ConfirmTarget) => (
            <>
                Permanently delete <strong>{name}</strong>? A safety copy is the only record of the account as it was at
                that moment, and on a remote mount its own bucket objects are deleted with it.
            </>
        ),
        action: 'Delete',
    },
};

type BackupConfirm = { kind: keyof typeof CONFIRM_COPY; name: string };

type BackupSectionProps = {
    ownerId: string;
};

export function BackupSection({ ownerId }: BackupSectionProps) {
    const confirmDialog = useDialogValue<BackupConfirm>();
    const confirm = confirmDialog.value;
    const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    const { data, isLoading, isError } = useBackupArtifacts(ownerId);
    const { data: jobs = [], isError: jobsFailed } = useBackupJobs(ownerId);
    const startBackup = useStartBackup(ownerId);
    const isOwner = useIsOrgOwner();
    const uploadBackup = useUploadBackup();
    const verifyBackup = useVerifyBackup(ownerId);
    const restoreBackup = useRestoreBackup(ownerId);
    const restoreSafetyCopy = useRestoreSafetyCopy(ownerId);
    const deleteArtifact = useDeleteBackupArtifact(ownerId);
    const deleteSafetyCopy = useDeleteSafetyCopy(ownerId);

    // Newest first. The server runs one job per home at a time, so the newest job is the whole story.
    const latest = jobs[0];
    const running = latest?.state === 'running' ? latest : undefined;
    const rowCount = data ? data.artifacts.length + data.safetyCopies.length : 0;

    const runConfirmed = async ({ kind, name }: BackupConfirm) => {
        if (kind === 'restore-artifact') await restoreBackup.mutateAsync(name);
        else if (kind === 'delete-artifact') await deleteArtifact.mutateAsync(name);
        else if (kind === 'restore-copy') await restoreSafetyCopy.mutateAsync(name);
        else await deleteSafetyCopy.mutateAsync(name);
    };

    const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) uploadBackup.mutate(file);
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
                    {isOwner && (
                        <>
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
                        </>
                    )}
                </div>
            </div>

            {rowCount > 0 && (
                <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        An archive holds everything in this account: files, mail, calendars and the stored storage
                        credentials. It is a secret, so keep it somewhere safe.
                    </AlertDescription>
                </Alert>
            )}

            {latest && latest.id !== dismissedJobId && (
                <BackupJobStatus job={latest} onDismiss={() => setDismissedJobId(latest.id)} />
            )}
            {jobsFailed && (
                <p className="text-xs text-destructive">Could not load the jobs running for this account.</p>
            )}

            {isLoading ? (
                <LoadingState />
            ) : isError || !data ? (
                <ErrorState message="Could not load the backups of this account." />
            ) : rowCount === 0 ? (
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
                            onRestore={() =>
                                confirmDialog.openDialog({ kind: 'restore-artifact', name: artifact.name })
                            }
                            onDelete={() => confirmDialog.openDialog({ kind: 'delete-artifact', name: artifact.name })}
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
                                    onRestore={() =>
                                        confirmDialog.openDialog({ kind: 'restore-copy', name: copy.name })
                                    }
                                    onDelete={() => confirmDialog.openDialog({ kind: 'delete-copy', name: copy.name })}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {confirm && (
                <ConfirmDialog
                    open={confirmDialog.open}
                    onOpenChange={confirmDialog.setOpen}
                    title={CONFIRM_COPY[confirm.kind].title}
                    description={CONFIRM_COPY[confirm.kind].description({ name: confirm.name, ownerId })}
                    onConfirm={() => runConfirmed(confirm)}
                    confirmText={CONFIRM_COPY[confirm.kind].action}
                    destructive
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
    // A mount the home had turned off whose storage could not be read: the archive holds nothing for
    // it, and the row says so rather than letting the admin assume it is in there.
    const skipped = artifact.manifest?.mounts.filter((mount) => mount.skipped) ?? [];
    // A metadata-only member of a whole-server archive: restoreHome refuses it, so the row says why
    // instead of offering it.
    const incomplete = artifact.manifest && incompleteReason(artifact.manifest);
    // Without a manifest (an archive copied in by hand) nothing is known of what it holds. A verify writes one.
    const restorable = artifact.manifest !== null && artifact.verify.status !== 'failed' && !incomplete;
    return (
        <BackupArtifactRow
            createdAt={artifact.createdAt}
            detail={`${formatFileSize(artifact.bytes)} · ${artifact.name}`}
            badges={<VerifyBadge verify={artifact.verify} />}
            actions={
                <>
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
                    {/* The lines below say why an archive is not offered. */}
                    {restorable && (
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
                </>
            }
        >
            {!artifact.manifest && (
                <p className="text-xs text-muted-foreground pl-7">
                    Verify first: nothing is known about this archive until then.
                </p>
            )}
            {incomplete && <p className="text-xs text-muted-foreground pl-7">This archive {incomplete}.</p>}
            {skipped.map((mount) => (
                <p key={mount.id} className="text-xs text-muted-foreground pl-7 truncate">
                    Skipped mount {mount.id}: {mount.skipped}
                </p>
            ))}
            {/* Still restorable: what it lacks, the live home cannot serve either. */}
            <VerifyLines lines={artifact.manifest?.warnings ?? []} tone="warning" />
            <VerifyFailures verify={artifact.verify} />
        </BackupArtifactRow>
    );
}

type SafetyCopyRowProps = {
    copy: BackupSafetyCopy;
    busy: boolean;
    onRestore: () => void;
    onDelete: () => void;
};

function SafetyCopyRow({ copy, busy, onRestore, onDelete }: SafetyCopyRowProps) {
    // Measuring a whole home stops after a cap, so the number is a floor.
    const size = `${copy.truncated ? 'at least ' : ''}${formatFileSize(copy.bytes)}`;
    return (
        <BackupArtifactRow
            icon={RotateCcw}
            createdAt={copy.createdAt}
            detail={`${SAFETY_COPY_LABEL[copy.kind]} · ${size}`}
            actions={
                <>
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
                </>
            }
        />
    );
}
