import { STORAGE_TYPE_LABELS } from '@workspace/lib/constants/mount';
import { useCheckS3Connection, useHardenS3Bucket, useServerSettings } from '@workspace/lib/settings';
import { useAddTeamMount, useTeamMounts, useUpdateTeamMount } from '@workspace/lib/team';
import type { S3Config } from '@workspace/lib/types/mount';
import { type MountSettings, mapStorageType } from '@workspace/lib/types/settings';
import { EmptyState, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import type { MountFormValues } from '@workspace/ui/components/mount/mount-form';
import { Switch } from '@workspace/ui/components/switch';
import { HardDrive, Settings } from 'lucide-react';
import { useState } from 'react';
import { MountDialog } from './mount-dialog';

type TeamMountsSectionProps = {
    teamId: string;
};

export function TeamMountsSection({ teamId }: TeamMountsSectionProps) {
    const [showAddMount, setShowAddMount] = useState(false);
    const [editingMount, setEditingMount] = useState<{ id: string; mount: MountSettings } | null>(null);

    const { data: serverSettings } = useServerSettings();
    const s3Check = useCheckS3Connection();
    const s3Harden = useHardenS3Bucket();

    const { data: mounts = {} } = useTeamMounts(teamId);
    const addMount = useAddTeamMount(teamId);
    const updateMount = useUpdateTeamMount(teamId);

    const handleAddMount = async (values: MountFormValues) => {
        await addMount.mutateAsync({
            name: values.name,
            storageType: values.storageType,
            maxSizeMB: values.maxSizeMB,
            s3Config: values.s3Config,
        });
    };

    const handleEditMount = async (values: MountFormValues) => {
        if (!editingMount) return;
        await updateMount.mutateAsync({
            mountId: editingMount.id,
            maxSizeMB: values.maxSizeMB,
            name: values.name,
            s3Config: values.s3Config,
        });
    };

    const handleS3Check = (config: S3Config) => s3Check.mutateAsync(config);
    const handleS3Harden = (config: S3Config, noncurrentDays: number) =>
        s3Harden.mutateAsync({ ...config, noncurrentDays });

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Mounts ({Object.keys(mounts).length})</h3>
                <Button variant="ghost" size="sm" onClick={() => setShowAddMount(true)}>
                    <HardDrive className="h-4 w-4 mr-1" />
                    Add
                </Button>
            </div>

            <MountDialog
                open={showAddMount}
                onOpenChange={setShowAddMount}
                onSubmit={handleAddMount}
                onS3Check={handleS3Check}
                onS3Harden={handleS3Harden}
                title="Add Mount"
                submitLabel="Create Mount"
                defaultStorageType={serverSettings && mapStorageType(serverSettings.defaults.mount.storageType)}
                defaultMaxSizeMB={serverSettings?.quotas.defaultMountMaxSizeMB}
                defaultS3Config={serverSettings?.defaults.mount.s3Config}
            />

            <MountDialog
                open={!!editingMount}
                onOpenChange={(open) => {
                    if (!open) setEditingMount(null);
                }}
                onSubmit={handleEditMount}
                onS3Check={handleS3Check}
                onS3Harden={handleS3Harden}
                initialValues={
                    editingMount
                        ? {
                              name: editingMount.mount.name ?? editingMount.id,
                              storageType: editingMount.mount.storageType,
                              maxSizeMB: editingMount.mount.maxSizeMB,
                              s3Config: editingMount.mount.s3Config,
                          }
                        : undefined
                }
                title="Edit Mount"
                submitLabel="Save Changes"
                isEdit
            />

            {Object.keys(mounts).length === 0 ? (
                <EmptyState
                    icon={<HardDrive className="h-6 w-6" />}
                    message="No mounts yet"
                    hint="Add one to give this team a drive."
                />
            ) : (
                <div className="space-y-2">
                    {Object.entries(mounts).map(([id, mount]) => (
                        <div key={id} className="flex items-center gap-3 p-3 border rounded-lg">
                            <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{mount.name || id}</div>
                                <div className="text-xs text-muted-foreground">
                                    {STORAGE_TYPE_LABELS[mount.storageType]} · {mount.maxSizeMB ?? '∞'} MB
                                </div>
                            </div>
                            <TooltipButton
                                icon={Settings}
                                tooltipText="Mount settings"
                                className="h-7 w-7 shrink-0"
                                onClick={() => setEditingMount({ id, mount })}
                            />
                            <Switch
                                checked={mount.enabled}
                                onCheckedChange={async (enabled) => {
                                    await updateMount.mutateAsync({ mountId: id, enabled });
                                }}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
