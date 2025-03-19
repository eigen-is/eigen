import { UserPlus, Users, Star, Clock, PlusCircle, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
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

  // Debug log to check labels array
  console.log('Current labels state:', labels);

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
        <Button className={`${condensed ? 'justify-center w-10 px-0' : 'w-full justify-start gap-2'}`} size={condensed ? "icon" : "lg"} asChild>
          <Link to="/new">
            <UserPlus className="h-4 w-4"/>
            {!condensed && <span>Create contact</span>}
          </Link>
        </Button>
      </div>

      <div className="overflow-auto flex-1">
        <div className="px-3 py-2">
          <nav className="space-y-1">
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'all' }}
              className={`flex items-center ${condensed ? 'justify-center' : 'gap-3'} rounded-md px-3 py-2 text-sm font-medium cursor-pointer`}
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
              activeOptions={{ exact: false }}
            >
              <Users className="h-4 w-4" />
              {!condensed && <span>All contacts</span>}
            </Link>
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'frequent' }}
              className={`flex items-center ${condensed ? 'justify-center' : 'gap-3'} rounded-md px-3 py-2 text-sm font-medium cursor-pointer`}
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <Star className="h-4 w-4" />
              {!condensed && <span>Frequent</span>}
            </Link>
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'recent' }}
              className={`flex items-center ${condensed ? 'justify-center' : 'gap-3'} rounded-md px-3 py-2 text-sm font-medium cursor-pointer`}
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <Clock className="h-4 w-4" />
              {!condensed && <span>Recent</span>}
            </Link>
          </nav>
        </div>

        {/* Horizontal separator */}
        <div className="mx-3 my-2 border-t border-border"></div>

        {/* Status messages */}
        {error ? (
          <div className="px-3 py-2 text-sm text-destructive">An error occurred while loading labels.</div>
        ) : loading ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Loading labels...</div>
        ) : labels.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">No labels found. Add one with the + button.</div>
        ) : (
          <>
            {condensed ? (
              <div className="px-3 py-2">
                <div className="flex justify-center">
                  <Button size="icon" variant="ghost" onClick={() => {}} className="h-8 w-8">
                    <PlusCircle className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-1 mt-2">
                  {labels.map(label => (
                    <Link
                      key={label.id}
                      to="/c/$filterType/$filterId"
                      params={{ filterType: 'label', filterId: label.id }}
                      className="flex justify-center rounded-md px-3 py-2 text-sm font-medium cursor-pointer"
                      activeProps={{
                        className: 'bg-primary/10 text-primary',
                      }}
                      inactiveProps={{
                        className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      }}
                    >
                      <span 
                        className="h-3 w-3 rounded-full" 
                        style={{ backgroundColor: label.color }}
                      />
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <LabelManager
                labels={labels}
                onAddLabel={handleAddLabel}
                onEditLabel={handleEditLabel}
                onDeleteLabel={handleDeleteLabel}
                getLabelPath={getLabelPath}
                className="px-3 custom-label-manager"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
