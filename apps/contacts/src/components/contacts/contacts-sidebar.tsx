import {Clock, Star, UserRoundPlus, UsersRound, X} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import {Button} from "@workspace/ui/components/button";
import {LabelManager} from '@workspace/ui/components/layout/labels/label-manager';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';
import {type Label} from "@workspace/lib/types/label";
import {useLabels} from '@workspace/lib/contacts';
import {AppLogo} from '@workspace/ui/components/layout/app/app-logo.tsx';
import {EigenLoader, StorageUsage} from "@workspace/ui";

interface ContactsSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    onAssignLabel?: (contactIds: string[], labelId: string) => void;
}

export function ContactsSidebar({condensed = false, onClose, isMobile = false, onAssignLabel}: ContactsSidebarProps) {
    const {
        data: labels = [],
        isLoading: loading,
        error
    } = useLabels();

    const getLabelPath = (label: Label) => `/label/${label.id.toLowerCase()}`;

    return (
        <div className="h-full flex flex-col bg-background">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="contacts"/>
                </div>
            )}

            <div className="px-3 py-2">
                <Button variant="default" size={condensed ? "icon" : "default"} asChild
                        className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}>
                    <Link to="/new">
                        <UserRoundPlus className="h-4 w-4"/>
                        {!condensed && <span>Create contact</span>}
                    </Link>
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<UsersRound className="h-4 w-4"/>}
                        label="All contacts"
                        to="/$filterType/$filterId"
                        params={{filterType: 'book', filterId: 'all'}}
                        condensed={condensed}
                    />

                    <SidebarItem
                        icon={<Star className="h-4 w-4"/>}
                        label="Frequent"
                        to="/$filterType/$filterId"
                        params={{filterType: 'book', filterId: 'frequent'}}
                        condensed={condensed}
                    />

                    <SidebarItem
                        icon={<Clock className="h-4 w-4"/>}
                        label="Recent"
                        to="/$filterType/$filterId"
                        params={{filterType: 'book', filterId: 'recent'}}
                        condensed={condensed}
                    />
                </SidebarSection>

                <Separator/>

                {error ? (
                    <div className="px-3 py-2 text-sm text-destructive">An error occurred while loading labels.</div>
                ) : loading ? (
                    <EigenLoader/>
                ) : labels.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No labels found. Add one with the +
                        button.</div>
                ) : (
                    <LabelManager
                        labels={labels}
                        getLabelPath={getLabelPath}
                        className="px-3"
                        condensed={condensed}
                        dropAcceptTypes={onAssignLabel ? ['contact'] : undefined}
                        onItemDrop={onAssignLabel}
                    />
                )}
            </div>

            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />
        </div>
    );
}
