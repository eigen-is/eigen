import { formatDateTime } from '@workspace/lib/date';
import type { BackupVerifyRecord } from '@workspace/lib/types/backup';
import { Badge } from '@workspace/ui/components/badge';
import { Archive } from 'lucide-react';
import type { ReactNode } from 'react';

// The verify status is a server word; this is the one an admin reads.
const VERIFY_LABEL: Record<BackupVerifyRecord['status'], string> = {
    verified: 'Verified',
    failed: 'Failed',
    unverified: 'Not verified',
};

export function VerifyBadge({ verify }: { verify: BackupVerifyRecord }) {
    const label = VERIFY_LABEL[verify.status];
    if (verify.status === 'verified') return <Badge variant="secondary">{label}</Badge>;
    if (verify.status === 'failed') return <Badge variant="destructive">{label}</Badge>;
    return <Badge variant="outline">{label}</Badge>;
}

export function VerifyFailures({ verify }: { verify: BackupVerifyRecord }) {
    if (verify.status !== 'failed') return null;
    return (
        <ul className="text-xs text-destructive max-h-24 overflow-y-auto pl-7 list-disc">
            {verify.failures.map((failure) => (
                <li key={failure}>{failure}</li>
            ))}
        </ul>
    );
}

type BackupArtifactRowProps = {
    createdAt: Date;
    detail: string;
    badges: ReactNode;
    actions: ReactNode;
    // The lines under the row, each saying what the archive lacks or what went wrong.
    children?: ReactNode;
};

// One archive in a backup list, a home's or the server's.
export function BackupArtifactRow({ createdAt, detail, badges, actions, children }: BackupArtifactRowProps) {
    return (
        <div className="group flex flex-col gap-1 p-3 border rounded-lg">
            <div className="flex items-center gap-3">
                <Archive className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{formatDateTime(createdAt)}</div>
                    <div className="text-xs text-muted-foreground truncate">{detail}</div>
                </div>
                {badges}
                <div className="flex items-center invisible group-hover:visible pointer-coarse:visible">{actions}</div>
            </div>
            {children}
        </div>
    );
}
