import { STORAGE_TYPE_HINTS, STORAGE_TYPE_LABELS } from '@workspace/lib/constants/mount';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult, ServerStorageType } from '@workspace/lib/types/settings';
import { isServerStorageType, mapStorageType, SERVER_STORAGE_TYPES } from '@workspace/lib/types/settings';
import { Label } from '@workspace/ui/components/label';
import { S3ConfigCard } from '@workspace/ui/components/mount';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useEffect, useState } from 'react';

type StorageTypePickerProps = {
    storageType: ServerStorageType;
    onStorageTypeChange: (type: ServerStorageType) => void;
    s3Config: S3Config;
    onS3ConfigChange: (config: S3Config) => void;
    checkS3: (config: S3Config) => Promise<S3CheckResult>;
    hardenS3: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    onS3Verified?: (verified: boolean) => void;
};

export function StorageTypePicker({
    storageType,
    onStorageTypeChange,
    s3Config,
    onS3ConfigChange,
    checkS3,
    hardenS3,
    onS3Verified,
}: StorageTypePickerProps) {
    const [s3CheckResult, setS3CheckResult] = useState<S3CheckResult | null>(null);

    const isS3 = storageType === 's3';

    useEffect(() => {
        onS3Verified?.(!isS3 || !!s3CheckResult?.ok);
    }, [isS3, s3CheckResult, onS3Verified]);

    const handleStorageTypeChange = (type: ServerStorageType) => {
        onStorageTypeChange(type);
        setS3CheckResult(null);
    };

    return (
        <div className="space-y-4">
            <div className="space-y-1.5">
                <Label>Storage Type</Label>
                <Select
                    value={storageType}
                    onValueChange={(value) => isServerStorageType(value) && handleStorageTypeChange(value)}
                >
                    <SelectTrigger className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {SERVER_STORAGE_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                                {STORAGE_TYPE_LABELS[mapStorageType(type)]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{STORAGE_TYPE_HINTS[mapStorageType(storageType)]}</p>
            </div>

            {isS3 && (
                <S3ConfigCard
                    value={s3Config}
                    onChange={onS3ConfigChange}
                    onCheck={checkS3}
                    onHarden={hardenS3}
                    onCheckResult={setS3CheckResult}
                />
            )}
        </div>
    );
}
