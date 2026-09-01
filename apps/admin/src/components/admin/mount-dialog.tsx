import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { MountForm, type MountFormValues } from '@workspace/ui/components/mount/mount-form';

type MountDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (values: MountFormValues) => Promise<void>;
    onS3Check: (config: S3Config) => Promise<S3CheckResult>;
    onS3Harden: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    initialValues?: Partial<MountFormValues>;
    title: string;
    submitLabel: string;
    isEdit?: boolean;
    defaultStorageType?: MountFormValues['storageType'];
    defaultMaxSizeMB?: number;
    defaultS3Config?: S3Config;
};

export function MountDialog({
    open,
    onOpenChange,
    onSubmit,
    onS3Check,
    onS3Harden,
    initialValues,
    title,
    submitLabel,
    isEdit,
    defaultStorageType,
    defaultMaxSizeMB,
    defaultS3Config,
}: MountDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <MountForm
                    initialValues={initialValues}
                    defaultStorageType={defaultStorageType}
                    defaultMaxSizeMB={defaultMaxSizeMB}
                    defaultS3Config={defaultS3Config}
                    onSubmit={async (values) => {
                        await onSubmit(values);
                        onOpenChange(false);
                    }}
                    onCancel={() => onOpenChange(false)}
                    onS3Check={onS3Check}
                    onS3Harden={onS3Harden}
                    submitLabel={submitLabel}
                    isEdit={isEdit}
                />
            </DialogContent>
        </Dialog>
    );
}
