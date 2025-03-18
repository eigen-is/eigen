import { UserPlus, Users, Star, Clock } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
import { type Label } from "@apps/api-server/types/label";
import { useLabels, useAddLabel, useUpdateLabel, useDeleteLabel } from '../../src/hooks/use-labels';

export function ContactsSidebar() {
  // Gebruik de useLabels hook van TanStack Query
  const { 
    data: labels = [], 
    isLoading: loading,
    error 
  } = useLabels();
  
  // Gebruik de mutatie hooks van TanStack Query
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
    <div className="w-64 border-r h-full flex flex-col bg-background">
      <div className="p-4">
        <Button className="w-full justify-start gap-2" size="lg">
          <UserPlus className="h-4 w-4"/>
          Create contact
        </Button>
      </div>

      <div className="overflow-auto flex-1">
        <div className="px-3 py-2">
          <nav className="space-y-1">
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'all' }}
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
              activeOptions={{ exact: false }}
            >
              <Users className="h-4 w-4" />
              <span>All contacts</span>
            </Link>
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'frequent' }}
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <Star className="h-4 w-4" />
              <span>Frequent</span>
            </Link>
            <Link
              to="/c/$filterType/$filterId"
              params={{ filterType: 'filter', filterId: 'recent' }}
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <Clock className="h-4 w-4" />
              <span>Recent</span>
            </Link>
          </nav>
        </div>

        {/* Horizontal separator */}
        <div className="mx-3 my-2 border-t border-border"></div>

        {/* Status berichten */}
        {error ? (
          <div className="px-3 py-2 text-sm text-destructive">Er is een fout opgetreden bij het laden van labels.</div>
        ) : loading ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Loading labels...</div>
        ) : labels.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">No labels found. Add one with the + button.</div>
        ) : (
          <>
            {/* Use the shared LabelManager component */}
            <LabelManager
              labels={labels}
              onAddLabel={handleAddLabel}
              onEditLabel={handleEditLabel}
              onDeleteLabel={handleDeleteLabel}
              getLabelPath={getLabelPath}
              className="px-3 custom-label-manager"
            />
          </>
        )}
      </div>
    </div>
  );
}
