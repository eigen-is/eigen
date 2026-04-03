import { useActiveMember } from '@workspace/lib/admin';
import { getAdminAppUrl } from '@workspace/lib/api';
import { SidebarItem, StorageUsage } from '@workspace/ui';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { BookUser, Download, KeySquare, LockKeyholeIcon, Shield, UserRound } from 'lucide-react';

type SpaceSidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
};

export function SpaceSidebar({ condensed = false, onClose, isMobile = false }: SpaceSidebarProps) {
    const { data: activeMember } = useActiveMember();
    const isAdmin = activeMember?.role === 'admin' || activeMember?.role === 'owner';

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="space" onClose={onClose} />}

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<UserRound className="h-4 w-4" />}
                    label="Home"
                    condensed={condensed}
                    to="/"
                    params={{}}
                />
                <SidebarItem
                    icon={<BookUser className="h-4 w-4" />}
                    label="Personal info"
                    condensed={condensed}
                    to="/user"
                    params={{}}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    label="Data export"
                    condensed={condensed}
                    to="/data"
                    params={{}}
                />
            </SidebarSection>

            <Separator />

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<LockKeyholeIcon className="h-4 w-4" />}
                    label="Change password"
                    condensed={condensed}
                    to="/security/password"
                    params={{}}
                />
                <SidebarItem
                    icon={<KeySquare className="h-4 w-4" />}
                    label="Two factor authentication"
                    condensed={condensed}
                    to="/security/2fa"
                    params={{}}
                />
                {/*SidebarItem
                    icon={<Smartphone className="h-4 w-4"/>}
                    label="Recovery codes"
                    to='/security/recovery-codes' params={{}}/> */}
            </SidebarSection>

            {isAdmin && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed}>
                        <a
                            href={getAdminAppUrl()}
                            className={`flex items-center rounded-md px-3 py-2 text-sm font-medium select-none text-muted-foreground hover:bg-muted hover:text-foreground ${condensed ? 'justify-center' : 'gap-3'}`}
                        >
                            <Shield className="h-4 w-4" />
                            {!condensed && <span>Admin</span>}
                        </a>
                    </SidebarSection>
                </>
            )}

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage className="mt-auto" condensed={condensed} />
        </div>
    );
}
