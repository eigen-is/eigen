import type { BackupJob } from '@workspace/lib/types/backup';
import { TooltipButton } from '@workspace/ui';
import { Progress } from '@workspace/ui/components/progress';
import { cn } from '@workspace/ui/lib/utils';
import { Loader2, X } from 'lucide-react';

const JOB_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Creating backup',
    verify: 'Verifying archive',
    restore: 'Restoring account',
    'server-backup': 'Backing up the server',
    upload: 'Uploading the server backup',
};

const JOB_DONE_LABEL: Record<BackupJob['kind'], string> = {
    backup: 'Backup created',
    verify: 'Archive verified',
    restore: 'Account restored',
    'server-backup': 'Server backed up',
    upload: 'Server backup uploaded',
};

// A running job's step and progress, or the line a finished one leaves until it is dismissed.
export function BackupJobStatus({ job, onDismiss }: { job: BackupJob; onDismiss: () => void }) {
    if (job.state === 'running') {
        const { step, done, total } = job.progress;
        // A one-shot step (total 1) says no more than the job's label. A counted step shows its bar until its last
        // item; the work after that reports nothing, so it spins rather than rest at 100%.
        const counting = total > 1 && done < total;
        return (
            <div className="space-y-1">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    {!counting && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                    <span>
                        {JOB_LABEL[job.kind]}
                        {total !== 1 && ` · ${step}`}
                        {counting && ` (${done}/${total})`}
                    </span>
                </p>
                {counting && <Progress value={(done / total) * 100} />}
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
