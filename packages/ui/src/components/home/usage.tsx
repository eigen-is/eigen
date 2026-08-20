import { formatFileSize } from '@workspace/lib/format';
import { useHomeSize } from '@workspace/lib/home';
import { Progress } from '@workspace/ui/components/progress';
import { cn } from '@workspace/ui/lib/utils';
import { useState } from 'react';
import { EigenLoader } from '../braket/eigen-loader';

export type StorageData = {
    mailAndContacts: { used: number; max: number };
    drive: { default: { used: number; max: number } };
    total: { used: number; max: number };
};

type StorageUsageProps = {
    className?: string;
    condensed?: boolean;
};

// Hardcoded colors are intentional: red/yellow for storage warning thresholds (no theme token for warning)
export const getStorageUsageColor = (storageUsed: number): string => {
    if (!storageUsed || Number.isNaN(storageUsed) || storageUsed === Infinity) return '';
    else if (storageUsed > 0.85) return 'bg-red-500';
    else if (storageUsed > 0.65) return 'bg-yellow-500';
    return '';
};

// Presentational storage breakdown: total line + fill bar + Drive/Mail rows. Shared by the admin
// user detail pane and any other surface that already has a StorageData in hand.
export function StorageUsageBars({ data, className }: { data: StorageData; className?: string }) {
    // Clamp: over-quota users exist in prod, and Progress must not exceed 100%.
    const ratio = data.total.max > 0 ? Math.min(data.total.used / data.total.max, 1) : 0;

    return (
        <div className={cn('space-y-3', className)}>
            <div>
                <div className="flex justify-between text-sm mb-1">
                    <span className="text-muted-foreground">Total</span>
                    <span>
                        {formatFileSize(data.total.used)} / {formatFileSize(data.total.max)}
                    </span>
                </div>
                <Progress value={ratio * 100} indicatorClassName={getStorageUsageColor(ratio)} className="h-1.5" />
            </div>
            <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Drive</span>
                <span>{formatFileSize(data.drive.default.used)}</span>
            </div>
            <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Mail & contacts</span>
                <span>{formatFileSize(data.mailAndContacts.used)}</span>
            </div>
        </div>
    );
}

export function StorageUsage({ className = '', condensed = false }: StorageUsageProps) {
    const { data: storageData, isLoading: storageLoading } = useHomeSize();
    const [showDetails, setShowDetails] = useState(false);

    const totalUsed = storageData?.total.used ?? 0;
    const totalMax = storageData?.total.max ?? 1;
    const ratio = totalUsed / totalMax;

    return (
        <button
            type="button"
            aria-expanded={showDetails}
            className={cn('w-full text-left py-3 select-none cursor-pointer', className)}
            onClick={() => setShowDetails(!showDetails)}
        >
            <div>
                {!condensed && (
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-normal text-muted-foreground">Storage</span>
                        <span className="text-xs text-muted-foreground">
                            {storageLoading ? (
                                <EigenLoader />
                            ) : storageData ? (
                                `${formatFileSize(totalUsed)} / ${formatFileSize(totalMax)}`
                            ) : (
                                'Unknown'
                            )}
                        </span>
                    </div>
                )}
                <Progress
                    value={storageLoading || !storageData ? 0 : ratio * 100}
                    indicatorClassName={getStorageUsageColor(storageLoading || !storageData ? 0 : ratio)}
                    className="h-1.5"
                />
            </div>

            <div
                className={cn(
                    'overflow-hidden transition-all duration-300 ease-in-out',
                    showDetails && !condensed ? 'max-h-36 opacity-100' : 'max-h-0 opacity-0',
                )}
            >
                {storageData && (
                    <div className="space-y-2 mt-2 text-xs">
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Mail & Contacts</span>
                            <span>{formatFileSize(storageData.mailAndContacts.used)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Drive</span>
                            <span>{formatFileSize(storageData.drive.default.used)}</span>
                        </div>
                    </div>
                )}
            </div>
        </button>
    );
}
