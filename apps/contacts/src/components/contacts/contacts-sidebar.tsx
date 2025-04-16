import {Clock, Star, UserPlus, Users, X} from 'lucide-react';
import {Link} from '@tanstack/react-router';
import {Button} from "@workspace/ui/components/button";
import {LabelManager} from '@workspace/ui/components/layout/labels/label-manager';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';
import {type Label} from "@apps/api-server/types/label";
import {useAddLabel, useDeleteLabel, useLabels, useUpdateLabel} from '@workspace/lib/contacts';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {EigenLoader, StorageUsage} from "@workspace/ui";
import {toast} from "sonner";

interface ContactsSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
}

export function ContactsSidebar({condensed = false, onClose, isMobile = false}: ContactsSidebarProps) {
    // Use the useLabels hook from TanStack Query
    const {
        data: labels = [],
        isLoading: loading,
        error
    } = useLabels();

    // Use the mutation hooks from TanStack Query
    const addLabelMutation = useAddLabel();
    const updateLabelMutation = useUpdateLabel();
    const deleteLabelMutation = useDeleteLabel();

    // Handle label operations
    const handleAddLabel = async (labelData: Omit<Label, 'id'>) => {
        try {
            console.log('Adding label:', labelData);
            await addLabelMutation.mutateAsync(labelData);
            toast.success(`Label ${labelData.name} added`);
        } catch (error) {
            console.error('Failed to add label:', error);
        }
    };

    const handleEditLabel = async (updatedLabel: Label) => {
        try {
            console.log('Editing label:', updatedLabel);
            await updateLabelMutation.mutateAsync(updatedLabel);
            toast.success('Label updated');
        } catch (error) {
            console.error('Failed to update label:', error);
        }
    };

    const handleDeleteLabel = async (labelId: string) => {
        try {
            console.log('Deleting label with ID:', labelId);
            await deleteLabelMutation.mutateAsync(labelId);
            toast.success('Label deleted');
        } catch (error) {
            console.error('Failed to delete label:', error);
        }
    };

    // Generate path for a label
    const getLabelPath = (label: Label) => `/label/${label.id.toLowerCase()}`;

    return (
        <div className="h-full flex flex-col bg-background">
            {/* Mobile Header with Close Button */}
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
                        <UserPlus className="h-4 w-4"/>
                        {!condensed && <span>Create contact</span>}
                    </Link>
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<Users className="h-4 w-4"/>}
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

                {/* Horizontal separator */}
                <Separator/>

                {/* Status messages or labels */}
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
                        onAddLabel={handleAddLabel}
                        onEditLabel={handleEditLabel}
                        onDeleteLabel={handleDeleteLabel}
                        getLabelPath={getLabelPath}
                        className="px-3"
                        condensed={condensed}
                    />
                )}
            </div>

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />
        </div>
    );
}
