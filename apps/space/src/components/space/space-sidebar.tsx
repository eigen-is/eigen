import {BookUser, CircleUser, Download, KeySquare, LockKeyholeIcon, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {Separator} from '@workspace/ui/components/separator';


interface SpaceSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function SpaceSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,

                             }: SpaceSidebarProps) {

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="drive"/>
                </div>
            )}

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<CircleUser className="h-4 w-4"/>}
                    label="Home"
                    condensed={condensed}
                    to='/' params={{}}/>
                <SidebarItem
                    icon={<BookUser className="h-4 w-4"/>}
                    label="Personal info"
                    condensed={condensed}
                    to='/user' params={{}}/>
                <SidebarItem
                    icon={<Download className="h-4 w-4"/>}
                    label="Data export"
                    condensed={condensed}
                    to='/data' params={{}}/>

            </SidebarSection>

            <Separator/>

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<LockKeyholeIcon className="h-4 w-4"/>}
                    label="Change password"
                    condensed={condensed}
                    to='/security/password' params={{}}/>
                <SidebarItem
                    icon={<KeySquare className="h-4 w-4"/>}
                    label="Two factor authentication"
                    condensed={condensed}
                    to='/security/2fa' params={{}}/>
                {/*SidebarItem
                    icon={<Smartphone className="h-4 w-4"/>}
                    label="Recovery codes"
                    to='/security/recovery-codes' params={{}}/> */}
            </SidebarSection>

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />
        </div>
    );
}
