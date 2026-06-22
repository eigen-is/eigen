import type { DrivePath } from '@workspace/lib/types/drive';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import type { EigenDocAppConfig } from './eigendoc-config';

type EigenDocNewButtonProps = {
    config: EigenDocAppConfig;
    rootPath: DrivePath | null;
    condensed?: boolean;
};

export function EigenDocNewButton({ config, rootPath, condensed = false }: EigenDocNewButtonProps) {
    const [createOpen, setCreateOpen] = useState(false);
    return (
        <>
            <SidebarPrimaryButton
                icon={Plus}
                label={config.newLabel}
                condensed={condensed}
                onClick={() => setCreateOpen(true)}
            />
            <DriveCreateEigenDoc
                open={createOpen}
                onOpenChange={setCreateOpen}
                type={config.createType}
                defaultOwnerId={rootPath?.ownerId}
                defaultFolderId={rootPath?.id}
                defaultMountId={rootPath?.mountId}
            />
        </>
    );
}
