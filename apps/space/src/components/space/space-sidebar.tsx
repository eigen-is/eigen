import { useIsAdmin } from '@workspace/lib/admin';
import { getAdminAppUrl } from '@workspace/lib/api';
import { SidebarItem, StorageUsage } from '@workspace/ui';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { BookUser, KeySquare, LockKeyholeIcon, Mail, MonitorSmartphone, Shield, UserRound } from 'lucide-react';

type SpaceSidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
};

export function SpaceSidebar({ condensed = false, onClose, isMobile = false }: SpaceSidebarProps) {
    const isAdmin = useIsAdmin();

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="space" onClose={onClose} />}

            <div className="flex flex-1 flex-col app-gutter">
                <SidebarSection condensed={condensed} className="px-0">
                    <SidebarItem
                        icon={<UserRound className="h-4 w-4" />}
                        label="Home"
                        condensed={condensed}
                        to="/"
                        params={{}}
                        exact
                    />
                    <SidebarItem
                        icon={<BookUser className="h-4 w-4" />}
                        label="Personal info"
                        condensed={condensed}
                        to="/user"
                        params={{}}
                    />
                    <SidebarItem
                        icon={<MonitorSmartphone className="h-4 w-4" />}
                        label="Integrations"
                        condensed={condensed}
                        to="/services"
                        params={{}}
                    />
                </SidebarSection>

                <SidebarSection condensed={condensed} className="px-0">
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
                </SidebarSection>

                <SidebarSection condensed={condensed} className="px-0" title={condensed ? undefined : 'App settings'}>
                    <SidebarItem
                        icon={<Mail className="h-4 w-4" />}
                        label="Mail"
                        condensed={condensed}
                        to="/email"
                        params={{}}
                    />
                </SidebarSection>

                {isAdmin && (
                    <SidebarSection condensed={condensed} className="px-0">
                        <SidebarItem
                            icon={<Shield className="h-4 w-4" />}
                            label="Admin"
                            condensed={condensed}
                            href={getAdminAppUrl()}
                        />
                    </SidebarSection>
                )}

                <StorageUsage className="mt-auto px-0" condensed={condensed} />
            </div>
        </div>
    );
}
