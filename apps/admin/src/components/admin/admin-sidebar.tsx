// The Admin app's navigation sidebar: one link per admin page, such as users, teams and guests. The
// owner also sees the server settings, onboarding and guest access pages, and the waitlist while it is on.
// The root route renders it inside the app shell for every signed-in admin.

import { SidebarBody, SidebarItem, SidebarSection } from '@workspace/ui';
import { ClipboardList, KeyRound, Settings, UserPlus, UserRoundCheck, Users, UsersRound } from 'lucide-react';

type AdminSidebarProps = {
    condensed?: boolean;
    isOwner?: boolean;
    waitlistEnabled?: boolean;
};

export function AdminSidebar({ condensed = false, isOwner = false, waitlistEnabled = false }: AdminSidebarProps) {
    return (
        <SidebarBody>
            <SidebarSection condensed={condensed}>
                {isOwner && (
                    <>
                        <SidebarItem
                            icon={<Settings className="h-4 w-4" />}
                            label="Settings"
                            to="/settings"
                            condensed={condensed}
                        />
                        <SidebarItem
                            icon={<ClipboardList className="h-4 w-4" />}
                            label="Onboarding"
                            to="/onboarding"
                            condensed={condensed}
                        />
                        <SidebarItem
                            icon={<KeyRound className="h-4 w-4" />}
                            label="Guest access"
                            to="/guest-settings"
                            condensed={condensed}
                        />
                    </>
                )}
                {isOwner && waitlistEnabled && (
                    <SidebarItem
                        icon={<UserPlus className="h-4 w-4" />}
                        label="Waitlist"
                        to="/waitlist"
                        condensed={condensed}
                    />
                )}
                <SidebarItem icon={<Users className="h-4 w-4" />} label="Users" to="/users" condensed={condensed} />
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4" />}
                    label="Teams"
                    to="/teams"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<UserRoundCheck className="h-4 w-4" />}
                    label="Guests"
                    to="/guests"
                    condensed={condensed}
                />
            </SidebarSection>

            {/* No StorageUsage: Admin is a server-admin surface, not a personal-storage context. */}
        </SidebarBody>
    );
}
