import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { MountForm, type MountFormValues } from '@workspace/ui/components/layout/mount/mount-form';

type MountFormProps = React.ComponentProps<typeof MountForm>;

type MountDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (values: MountFormValues) => Promise<void>;
    onS3Check?: MountFormProps['onS3Check'];
    initialValues?: Partial<MountFormValues>;
    title: string;
    submitLabel: string;
    isEdit?: boolean;
    defaultStorageType?: MountFormValues['storageType'];
    defaultMaxSizeMB?: number;
};

export function MountDialog({
    open,
    onOpenChange,
    onSubmit,
    onS3Check,
    initialValues,
    title,
    submitLabel,
    isEdit,
    defaultStorageType,
    defaultMaxSizeMB,
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
                    onSubmit={async (values) => {
                        await onSubmit(values);
                        onOpenChange(false);
                    }}
                    onCancel={() => onOpenChange(false)}
                    onS3Check={onS3Check}
                    submitLabel={submitLabel}
                    isEdit={isEdit}
                />
            </DialogContent>
        </Dialog>
    );
}
