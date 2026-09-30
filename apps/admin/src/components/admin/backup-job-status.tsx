import type { BackupJob } from '@workspace/lib/types/backup';
import { TooltipButton } from '@workspace/ui';
import { Progress } from '@workspace/ui/components/progress';
import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';

const JOB_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Creating backup',
    verify: 'Verifying archive',
    restore: 'Restoring home',
    'server-backup': 'Backing up the server',
    upload: 'Uploading the server backup',
};

const JOB_DONE_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Backup created',
    verify: 'Archive verified',
    restore: 'Home restored',
    'server-backup': 'Server backed up',
    upload: 'Server backup uploaded',
};

// A running job's step and progress, or the line a finished one leaves until it is dismissed.
export function BackupJobStatus({ job, onDismiss }: { job: BackupJob; onDismiss: () => void }) {
    if (job.state === 'running') {
        return (
            <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                    {JOB_LABEL[job.kind]} · {job.progress.step}
                    {job.progress.total > 0 && ` (${job.progress.done}/${job.progress.total})`}
                </p>
                {job.progress.total > 0 && <Progress value={(job.progress.done / job.progress.total) * 100} />}
            </div>
        );
    }
    return (
        <div className="flex items-start gap-1">
            <p
                className={cn(
                    'text-xs flex-1',
                    job.state === 'failed' ? 'text-destructive' : 'text-muted-foreground truncate',
                )}
            >
                {job.state === 'failed' ? (
                    <>
                        {JOB_LABEL[job.kind]} failed: {job.error}
                    </>
                ) : (
                    <>
                        {JOB_DONE_LABEL[job.kind]}
                        {job.artifact && ` · ${job.artifact}`}
                    </>
                )}
            </p>
            <TooltipButton icon={X} tooltipText="Dismiss" className="h-5 w-5 shrink-0" onClick={onDismiss} />
        </div>
    );
}
