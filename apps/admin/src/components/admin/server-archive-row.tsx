// One whole-server archive in the owner's list of backups: its date, level, reason and size, how its backup, verify
// and upload went, the users and teams it lacks or holds with warnings, and its upload and delete buttons.

import { BACKUP_LEVEL_NAMES } from '@workspace/lib/constants/backup';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupReason, ServerArchive } from '@workspace/lib/types/backup';
import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { AlertTriangle, CloudUpload, Trash2 } from 'lucide-react';
import { BackupArtifactRow, VerifyBadge, VerifyFailures } from './backup-artifact-row';

const REASON_LABEL: Record<BackupReason, string> = {
    scheduled: 'Scheduled',
    manual: 'Manual',
    'pre-update': 'Before an update',
};

type ServerArchiveRowProps = {
    archive: ServerArchive;
    uploadable: boolean;
    onUpload: () => void;
    onDelete: () => void;
};

export function ServerArchiveRow({ archive, uploadable, onUpload, onDelete }: ServerArchiveRowProps) {
    const { record } = archive;
    const homes = record?.manifest?.homes ?? [];
    const detail = [
        BACKUP_LEVEL_NAMES[archive.level],
        REASON_LABEL[archive.reason],
        archive.bytes !== null && formatFileSize(archive.bytes),
        archive.name,
    ].filter(Boolean);
    return (
        <BackupArtifactRow
            createdAt={archive.createdAt}
            detail={detail.join(' · ')}
            badges={
                <>
                    <StateBadge archive={archive} />
                    <UploadBadge archive={archive} uploadable={uploadable} />
                </>
            }
            actions={
                <>
                    {uploadable && (
                        <TooltipButton
                            icon={CloudUpload}
                            tooltipText="Upload to the bucket"
                            className="h-7 w-7"
                            onClick={onUpload}
                        />
                    )}
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        className="h-7 w-7"
                        disabled={record?.state === 'running' || record?.upload?.state === 'running'}
                        onClick={onDelete}
                    />
                </>
            }
        >
            {record?.error && <p className="text-xs text-destructive pl-7">{record.error}</p>}
            {record?.upload?.error && (
                <p className="text-xs text-destructive pl-7">Not uploaded: {record.upload.error}</p>
            )}
            <HomesAlert
                variant="destructive"
                title="Not in this backup:"
                homes={homes.flatMap(({ ownerId, name, failed }) => (failed ? [{ ownerId, name, why: failed }] : []))}
            />
            <HomesAlert
                variant="warning"
                title="In this backup with warnings:"
                homes={homes.flatMap(({ ownerId, name, warnings }) =>
                    warnings?.length ? [{ ownerId, name, why: warnings.join('; ') }] : [],
                )}
            />
            {record?.verify && <VerifyFailures verify={record.verify} />}
        </BackupArtifactRow>
    );
}

// A backup still being written, one that failed, or how its verify went. A record that is missing or does not
// read says so.
function StateBadge({ archive: { record } }: { archive: ServerArchive }) {
    if (!record) return <Badge variant="outline">No record</Badge>;
    if (record.state === 'running') return <Badge variant="outline">Running</Badge>;
    if (record.state === 'failed') return <Badge variant="destructive">Failed</Badge>;
    return record.verify ? <VerifyBadge verify={record.verify} /> : null;
}

function UploadBadge({ archive, uploadable }: { archive: ServerArchive; uploadable: boolean }) {
    const upload = archive.record?.upload;
    if (upload?.state === 'done') return <Badge variant="secondary">Uploaded</Badge>;
    if (upload?.state === 'running') return <Badge variant="outline">Uploading</Badge>;
    if (upload?.state === 'failed') return <Badge variant="destructive">Not uploaded</Badge>;
    return uploadable ? <Badge variant="outline">Not uploaded</Badge> : null;
}

type HomesAlertProps = {
    variant: 'destructive' | 'warning';
    title: string;
    homes: { ownerId: string; name: string; why: string }[];
};

// The homes of an archive the owner should look at: those it lacks, and those it holds with warnings.
function HomesAlert({ variant, title, homes }: HomesAlertProps) {
    if (homes.length === 0) return null;
    return (
        <Alert variant={variant} className="mt-1">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
                <p>{title}</p>
                <ul className="list-disc pl-4">
                    {homes.map((home) => (
                        <li key={home.ownerId}>
                            {home.name}: {home.why}
                        </li>
                    ))}
                </ul>
            </AlertDescription>
        </Alert>
    );
}
