import { UserPlus, Users, Star, Clock, X } from 'lucide-react';
import { Button } from "@workspace/ui/components/button";
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
import { SidebarItem } from '../../../../packages/ui/src/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '../../../../packages/ui/src/components/layout/sidebar/sidebar-section';
import { type Label } from "@apps/api-server/types/label";
import { useLabels, useAddLabel, useUpdateLabel, useDeleteLabel } from '../../src/hooks/use-labels';

interface ContactsSidebarProps {
  condensed?: boolean;
  onClose?: () => void;
  isMobile?: boolean;
}

export function ContactsSidebar({ condensed = false, onClose, isMobile = false }: ContactsSidebarProps) {
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
    } catch (error) {
      console.error('Failed to add label:', error);
    }
  };

  const handleEditLabel = async (updatedLabel: Label) => {
    try {
      console.log('Editing label:', updatedLabel);
      await updateLabelMutation.mutateAsync(updatedLabel);
    } catch (error) {
      console.error('Failed to update label:', error);
    }
  };

  const handleDeleteLabel = async (labelId: string) => {
    try {
      console.log('Deleting label with ID:', labelId);
      await deleteLabelMutation.mutateAsync(labelId);
    } catch (error) {
      console.error('Failed to delete label:', error);
    }
  };

  // Generate path for a label
  const getLabelPath = (label: Label) => `/c/label/${label.id.toLowerCase()}`;

  return (
    <div className="h-full flex flex-col bg-background">
      {isMobile && (
        <div className="p-2 flex justify-between items-center border-b">
          <h2 className="font-medium">Contacts</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="p-4">
        <SidebarItem 
          icon={<UserPlus className="h-4 w-4" />}
          label="Create contact"
          to="/new"
          condensed={condensed}
          className={condensed ? "w-10 px-0" : "w-full"}
        />
      </div>

      <div className="overflow-auto flex-1">
        <SidebarSection condensed={condensed}>
          <SidebarItem 
            icon={<Users className="h-4 w-4" />}
            label="All contacts"
            to="/c/$filterType/$filterId"
            params={{ filterType: 'filter', filterId: 'all' }}
            condensed={condensed}
          />
          
          <SidebarItem 
            icon={<Star className="h-4 w-4" />}
            label="Frequent"
            to="/c/$filterType/$filterId"
            params={{ filterType: 'filter', filterId: 'frequent' }}
            condensed={condensed}
          />
          
          <SidebarItem 
            icon={<Clock className="h-4 w-4" />}
            label="Recent"
            to="/c/$filterType/$filterId"
            params={{ filterType: 'filter', filterId: 'recent' }}
            condensed={condensed}
          />
        </SidebarSection>

        {/* Horizontal separator */}
        <div className="mx-3 my-2 border-t border-border"></div>

        {/* Status messages or labels */}
        {error ? (
          <div className="px-3 py-2 text-sm text-destructive">An error occurred while loading labels.</div>
        ) : loading ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Loading labels...</div>
        ) : labels.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">No labels found. Add one with the + button.</div>
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
    </div>
  );
}
