import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { DRIVE_TYPE_CHAT, type DrivePath } from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { ChatCreateWizard } from '../chat/chat-create-wizard';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';

type DriveCreateChatProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // The folder the create targets — decides wizard eligibility and its prefill.
    targetPath: DrivePath | null;
};

// The single "New chat" decision for every drive entry point (sidebar + New, list context menu,
// mobile toolbar). Person-mode create is strictly own-drive; team drives open team mode; guests
// and foreign user owners (shared-with-me folders) keep the bare create dialog.
export function DriveCreateChat({ open, onOpenChange, targetPath }: DriveCreateChatProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();

    // Mount-on-open: a drive page renders this per entry point — no idle wizard instances.
    if (!open) return null;

    const targetOwner = targetPath ? parseOwnerId(targetPath.ownerId) : null;
    const isOwnDrive = !!targetPath && targetPath.ownerId === user?.id;
    const usesWizard = !isGuest && (isOwnDrive || targetOwner?.type === 'team');

    if (!usesWizard) {
        return (
            <DriveCreateEigenDoc
                type={DRIVE_TYPE_CHAT}
                open={open}
                onOpenChange={onOpenChange}
                defaultOwnerId={targetPath?.ownerId}
                defaultFolderId={targetPath?.id}
                defaultMountId={targetPath?.mountId}
            />
        );
    }
    return (
        <ChatCreateWizard
            open={open}
            onOpenChange={onOpenChange}
            initialLocation={
                // Only a real subfolder pins the location — at the root the `chats` default wins.
                isOwnDrive && targetPath?.parentId
                    ? { ownerId: targetPath.ownerId, mountId: targetPath.mountId, folderId: targetPath.id }
                    : undefined
            }
            initialTeamId={targetOwner?.type === 'team' ? targetOwner.id : undefined}
        />
    );
}
