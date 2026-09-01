import { EMPTY_S3, isS3ConfigValid } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { useState } from 'react';
import { Button } from '../button';
import { DialogFooter } from '../dialog';
import { Input } from '../input';
import { Label } from '../label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { S3ConfigCard } from './s3-config-card';

export type MountFormValues = {
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    maxSizeMB: number;
    s3Config?: S3Config;
};

type MountFormProps = {
    defaultStorageType?: MountFormValues['storageType'];
    defaultMaxSizeMB?: number;
    defaultS3Config?: S3Config;
    initialValues?: Partial<MountFormValues>;
    onSubmit: (values: MountFormValues) => void | Promise<void>;
    onCancel?: () => void;
    onS3Check: (config: S3Config) => Promise<S3CheckResult>;
    onS3Harden: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    submitLabel?: string;
    isEdit?: boolean;
};

export function MountForm({
    defaultStorageType = 'local',
    defaultMaxSizeMB = 500,
    defaultS3Config,
    initialValues,
    onSubmit,
    onCancel,
    onS3Check,
    onS3Harden,
    submitLabel = 'Create Mount',
    isEdit = false,
}: MountFormProps) {
    const [name, setName] = useState(initialValues?.name ?? '');
    const [storageType, setStorageType] = useState<MountFormValues['storageType']>(
        initialValues?.storageType ?? defaultStorageType,
    );
    const [maxSizeMB, setMaxSizeMB] = useState(initialValues?.maxSizeMB ?? defaultMaxSizeMB);
    const [s3Config, setS3Config] = useState<S3Config>(
        initialValues?.s3Config ?? (defaultS3Config ? { ...defaultS3Config } : { ...EMPTY_S3 }),
    );
    const [submitting, setSubmitting] = useState(false);

    const isS3 = storageType === 's3';
    const canSubmit = name.trim() && maxSizeMB >= 10 && (!isS3 || isS3ConfigValid(s3Config));

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            await onSubmit({
                name: name.trim(),
                storageType,
                maxSizeMB,
                s3Config: isS3 ? s3Config : undefined,
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Shared Files"
                    autoFocus={!isEdit}
                />
            </div>

            <div className="space-y-1.5">
                <Label>Storage Type</Label>
                <Select
                    value={storageType}
                    onValueChange={(value) => setStorageType(value as MountFormValues['storageType'])}
                    disabled={isEdit}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="local">Local (full names)</SelectItem>
                        <SelectItem value="local-key">Local (ID-based)</SelectItem>
                        <SelectItem value="s3">S3 Bucket</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-1.5">
                <Label>Max Size (MB)</Label>
                <Input
                    type="number"
                    min={10}
                    value={maxSizeMB}
                    onChange={(e) => setMaxSizeMB(e.target.valueAsNumber || 10)}
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

            <DialogFooter>
                {onCancel && (
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
                    {submitting ? 'Saving...' : submitLabel}
                </Button>
            </DialogFooter>
        </div>
    );
}
