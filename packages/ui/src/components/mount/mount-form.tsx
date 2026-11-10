// The fields of a Drive mount's dialog: its name, its storage type and its maximum size, with the S3 fields when a
// bucket is picked. It renders inside a FormDialog, such as the admin's Add mount and Edit mount, and mounts with it,
// so each opening starts from the saved or default values. Its submit hands the values on, and the dialog waits for the
// save.

import { isStorageType, STORAGE_TYPE_HINTS, STORAGE_TYPE_LABELS } from '@workspace/lib/constants/mount';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import type { MountStorageType, S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3, isS3ConfigValid } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { useState } from 'react';
import { FormDialogForm } from '../form-dialog';
import { Input } from '../input';
import { Label } from '../label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { S3ConfigCard } from './s3-config-card';

export type MountFormValues = {
    name: string;
    storageType: MountStorageType;
    maxSizeMB: number;
    s3Config?: S3Config;
};

type MountFormProps = {
    defaultStorageType?: MountStorageType;
    defaultMaxSizeMB?: number;
    defaultS3Config?: S3Config;
    initialValues?: Partial<MountFormValues>;
    onSubmit: (values: MountFormValues) => Promise<void>;
    onS3Check: (config: S3Config) => Promise<S3CheckResult>;
    onS3Harden: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    submitLabel: string;
    isEdit?: boolean;
};

export function MountForm({
    defaultStorageType = 'local',
    defaultMaxSizeMB = 500,
    defaultS3Config,
    initialValues,
    onSubmit,
    onS3Check,
    onS3Harden,
    submitLabel,
    isEdit = false,
}: MountFormProps) {
    const [name, setName] = useState(initialValues?.name ?? '');
    const [storageType, setStorageType] = useState<MountStorageType>(initialValues?.storageType ?? defaultStorageType);
    const [maxSizeMB, setMaxSizeMB] = useState(initialValues?.maxSizeMB ?? defaultMaxSizeMB);
    const [s3Config, setS3Config] = useState(initialValues?.s3Config ?? defaultS3Config ?? EMPTY_S3);

    const isS3 = storageType === 's3';

    return (
        <FormDialogForm
            canSubmit={name.trim() !== '' && maxSizeMB >= QUOTA_MIN_MB && (!isS3 || isS3ConfigValid(s3Config))}
            submitLabel={submitLabel}
            onSubmit={() =>
                onSubmit({ name: name.trim(), storageType, maxSizeMB, s3Config: isS3 ? s3Config : undefined })
            }
        >
            <div className="space-y-1.5">
                <Label htmlFor="mount-name">Name</Label>
                <Input
                    id="mount-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. shared files"
                    autoFocus={!isEdit}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="mount-storage-type">Storage type</Label>
                <Select
                    value={storageType}
                    onValueChange={(value) => isStorageType(value) && setStorageType(value)}
                    disabled={isEdit}
                >
                    <SelectTrigger id="mount-storage-type">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {Object.entries(STORAGE_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{STORAGE_TYPE_HINTS[storageType]}</p>
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="mount-max-size">Max size (MB)</Label>
                <Input
                    id="mount-max-size"
                    type="number"
                    min={QUOTA_MIN_MB}
                    value={maxSizeMB}
                    onChange={(e) => setMaxSizeMB(e.target.valueAsNumber || QUOTA_MIN_MB)}
                />
            </div>

            {isS3 && (
                <S3ConfigCard
                    value={s3Config}
                    onChange={setS3Config}
                    onCheck={onS3Check}
                    onHarden={onS3Harden}
                    isEdit={isEdit}
                />
            )}
        </FormDialogForm>
    );
}
