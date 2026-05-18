import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
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
            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}
                    onClick={() => setCreateOpen(true)}
                >
                    <Plus className="h-4 w-4" />
                    {!condensed && <span>{config.newLabel}</span>}
                </Button>
            </div>
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
