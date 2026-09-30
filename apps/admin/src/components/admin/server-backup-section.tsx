import {
    useCheckBackupDestination,
    useDeleteServerArchive,
    useServerArchives,
    useServerBackupJobs,
    useStartServerBackup,
    useUploadServerArchive,
} from '@workspace/lib/admin';
import { BACKUP_LEVEL_NAMES } from '@workspace/lib/constants/backup';
import { formatTime } from '@workspace/lib/date';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupLevel, BackupReason, ServerArchive } from '@workspace/lib/types/backup';
import type { ServerSettings, ServerSettingsSaved } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { BACKUP_LEVELS, canUploadServerArchive } from '@workspace/lib/validation';
import { DeleteDialog, ErrorState, LoadingState, SettingsSection, TooltipButton } from '@workspace/ui';
import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { S3ConfigCard } from '@workspace/ui/components/mount';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { AlertTriangle, Archive, CloudUpload, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { BackupArtifactRow, VerifyBadge, VerifyFailures } from './backup-artifact-row';
import { BackupJobStatus } from './backup-job-status';
import { SwitchRow } from './switch-row';

type Backups = ServerSettings['backups'];

const REASON_LABEL: Record<BackupReason, string> = {
    scheduled: 'Scheduled',
    manual: 'Manual',
    'pre-update': 'Before an update',
};

// The owner picks an hour of their own day, listed in its order; the schedule runs on UTC.
function scheduleHours(): { hourUtc: number; label: string }[] {
    const hours = Array.from({ length: 24 }, (_, hourUtc) => {
        const at = new Date();
        at.setUTCHours(hourUtc, 0, 0, 0);
        return { hourUtc, at, label: `${formatTime(at)} (${String(hourUtc).padStart(2, '0')}:00 UTC)` };
    });
    const minuteOfDay = (at: Date) => at.getHours() * 60 + at.getMinutes();
    return hours.sort((a, b) => minuteOfDay(a.at) - minuteOfDay(b.at));
}

type ServerBackupSectionProps = {
    value: Backups;
    onChange: (patch: DeepPartial<Backups>) => void;
    // A blank secret in the form keeps the one the server holds for this destination.
    secretSaved: boolean;
    // Upload as saved, which is what the Upload route goes by.
    uploadSaved: boolean;
    saveNotice: Pick<ServerSettingsSaved, 'notice' | 'warning'> | null;
    onDismissNotice: () => void;
};

// The whole-server backup, on the owner's Settings page: its schedule and bucket are drafts the page's
// footer saves, the rest acts at once. No download: an archive leaves the box by scp or the bucket.
export function ServerBackupSection({
    value,
    onChange,
    secretSaved,
    uploadSaved,
    saveNotice,
    onDismissNotice,
}: ServerBackupSectionProps) {
    const [level, setLevel] = useState<BackupLevel>('full');
    const [deleting, setDeleting] = useState<string | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);

    const { data, isLoading, isError } = useServerArchives();
    const { data: jobs = [], isError: jobsFailed } = useServerBackupJobs();
    const startBackup = useStartServerBackup();
    const uploadArchive = useUploadServerArchive();
    const deleteArchive = useDeleteServerArchive();
    const checkDestination = useCheckBackupDestination();

    const hasS3Mounts = !!data?.hasS3Mounts;
    const levels = BACKUP_LEVELS.filter((option) => option !== 'full-s3' || hasS3Mounts);
    // Newest first. An upload can run beside the next backup, so every running job gets its line, and the newest
    // one that ended keeps its line until dismissed.
    const latest = jobs[0];
    const shown = jobs.filter((job) => job.state === 'running' || (job === latest && job.id !== dismissedJobId));
    const backingUp = jobs.some((job) => job.state === 'running' && job.kind === 'server-backup');

    const { schedule, upload } = value;

    return (
        <SettingsSection
            title="Backups"
            description="A backup of the whole server: every user and team, and the server's own databases and settings. Backups are not encrypted."
        >
            <SwitchRow
                label="Back up every night"
                description="A Full backup once a day at the time below. Turned on after that time, the first one starts within a few minutes."
                checked={schedule.enabled}
                onChange={(enabled) => onChange({ schedule: { enabled } })}
            />
            {schedule.enabled && (
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label>Time</Label>
                        <Select
                            value={String(schedule.hourUtc)}
                            onValueChange={(hour) => onChange({ schedule: { hourUtc: Number(hour) } })}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {scheduleHours().map((hour) => (
                                    <SelectItem key={hour.hourUtc} value={String(hour.hourUtc)}>
                                        {hour.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label>Nightly backups to keep</Label>
                        <Input
                            type="number"
                            min={1}
                            max={365}
                            value={schedule.keep}
                            onChange={(e) => {
                                const keep = e.target.valueAsNumber;
                                if (Number.isInteger(keep) && keep >= 1) onChange({ schedule: { keep } });
                            }}
                        />
                    </div>
                </div>
            )}
            {schedule.enabled && hasS3Mounts && (
                <SwitchRow
                    label="Include files in S3 buckets"
                    description="Copies every file of each S3 mount. Off, the backup holds their file list and the bucket keeps the files."
                    checked={schedule.withS3}
                    onChange={(withS3) => onChange({ schedule: { withS3 } })}
                />
            )}

            <SwitchRow
                label="Upload to a backup bucket"
                description="Each backup that verifies goes to a private S3 bucket that holds nothing else of Eigen. Backups made before an update stay on this server."
                checked={upload.enabled}
                onChange={(enabled) => onChange({ upload: { enabled } })}
            />
            {upload.enabled && (
                <>
                    <S3ConfigCard
                        value={upload.s3}
                        onChange={(s3) => onChange({ upload: { s3 } })}
                        onCheck={(config) => checkDestination.mutateAsync(config)}
                        secretSaved={secretSaved}
                    />
                    <div className="space-y-1.5">
                        <Label>Backups to keep in the bucket</Label>
                        <Input
                            type="number"
                            min={1}
                            max={365}
                            value={upload.keep}
                            onChange={(e) => {
                                const keep = e.target.valueAsNumber;
                                if (Number.isInteger(keep) && keep >= 1) onChange({ upload: { keep } });
                            }}
                        />
                    </div>
                </>
            )}
            {saveNotice && (
                <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="flex items-start gap-2">
                        <div className="flex-1 space-y-1">
                            {saveNotice.notice && <p>{saveNotice.notice}</p>}
                            {saveNotice.warning && <p>{saveNotice.warning}</p>}
                        </div>
                        <TooltipButton
                            icon={X}
                            tooltipText="Dismiss"
                            className="h-5 w-5 shrink-0"
                            onClick={onDismissNotice}
                        />
                    </AlertDescription>
                </Alert>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
                <h4 className="text-sm font-medium">Server backups</h4>
                <div className="flex items-center gap-2">
                    <Select value={level} onValueChange={(next) => setLevel(levels.find((l) => l === next) ?? 'full')}>
                        <SelectTrigger size="sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {levels.map((option) => (
                                <SelectItem key={option} value={option}>
                                    {BACKUP_LEVEL_NAMES[option]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={backingUp || startBackup.isPending}
                        onClick={() => startBackup.mutate(level)}
                    >
                        <Archive className="h-4 w-4 mr-1" />
                        Back up now
                    </Button>
                </div>
            </div>

            {shown.map((job) => (
                <BackupJobStatus key={job.id} job={job} onDismiss={() => setDismissedJobId(job.id)} />
            ))}
            {jobsFailed && <p className="text-xs text-destructive">Could not load the running backups.</p>}

            {isLoading ? (
                <LoadingState />
            ) : isError || !data ? (
                <ErrorState message="Could not load the server backups." />
            ) : data.archives.length === 0 ? (
                <p className="text-sm text-muted-foreground">No server backups yet.</p>
            ) : (
                <div className="space-y-2">
                    {data.archives.map((archive) => (
                        <ServerArchiveRow
                            key={archive.name}
                            archive={archive}
                            uploadable={canUploadServerArchive(archive, { uploadEnabled: uploadSaved, jobs })}
                            onUpload={() => uploadArchive.mutate(archive.name)}
                            onDelete={() => {
                                setDeleting(archive.name);
                                setDeleteOpen(true);
                            }}
                        />
                    ))}
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                Backups stay in the backups folder of your Eigen install. Copy one off the server with{' '}
                <code>{'scp you@server:/opt/eigen/backups/<name> .'}</code> Each file under homes/ in a backup is the
                backup of one user or team: extract it into the backups folder to restore that one from its page.
            </p>

            <DeleteDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete server backup"
                description="Permanently delete the backup"
                itemName={deleting ?? undefined}
                onDelete={async () => {
                    if (deleting) await deleteArchive.mutateAsync(deleting);
                }}
            />
        </SettingsSection>
    );
}

type ServerArchiveRowProps = {
    archive: ServerArchive;
    uploadable: boolean;
    onUpload: () => void;
    onDelete: () => void;
};

function ServerArchiveRow({ archive, uploadable, onUpload, onDelete }: ServerArchiveRowProps) {
    const { record } = archive;
    const failedHomes = record?.manifest?.homes.filter((home) => home.failed) ?? [];
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
            {failedHomes.length > 0 && (
                <Alert variant="destructive" className="mt-1">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                        <p>Not in this backup:</p>
                        <ul className="list-disc pl-4">
                            {failedHomes.map((home) => (
                                <li key={home.ownerId}>
                                    {home.name}: {home.failed}
                                </li>
                            ))}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}
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
