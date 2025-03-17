import { UserPlus, Users, Star, Clock } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { useState, useEffect } from 'react';
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
import { type Label } from "@apps/api-server/types/label";
import { contactsApi } from "../../../../packages/lib/src/lib/api"

export function ContactsSidebar() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch labels from the API
  useEffect(() => {
    const fetchLabels = async () => {
      try {
        setLoading(true);
        console.log('Fetching labels...');
        const response = await contactsApi.labels.get();
        console.log('Labels API response:', response);
        
        if (response.data) {
          console.log('Labels data:', response.data);
          setLabels(response.data);
        } else {
          console.log('No labels data found in response');
        }
      } catch (error) {
        console.error('Failed to fetch labels:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLabels();
  }, []);

  // Handle label operations
  const handleAddLabel = async (labelData: Omit<Label, 'id'>) => {
    try {
      console.log('Adding label:', labelData);
      const response = await contactsApi.labels.post({
        name: labelData.name,
        color: labelData.color
      });
      console.log('Add label response:', response);
      
      if (response.data) {
        // Refetch labels to get the updated list
        const labelsResponse = await contactsApi.labels.get();
        if (labelsResponse.data) {
          setLabels(labelsResponse.data);
        }
      }
    } catch (error) {
      console.error('Failed to add label:', error);
    }
  };

  const handleEditLabel = async (updatedLabel: Label) => {
    try {
      console.log('Editing label:', updatedLabel);
      
      // Direct post de data zoals bij toevoegen label
      const response = await contactsApi.labels[updatedLabel.id].put({
        name: updatedLabel.name,
        color: updatedLabel.color
      });
      console.log('Edit label response:', response);
      
      // Refetch labels to ensure we have the latest data
      const labelsResponse = await contactsApi.labels.get();
      if (labelsResponse.data) {
        console.log('Updated labels from server:', labelsResponse.data);
        setLabels(labelsResponse.data);
      } else {
        // Fallback to local update if fetch fails
        setLabels(labels.map(label => 
          label.id === updatedLabel.id ? {
            id: updatedLabel.id,
            name: updatedLabel.name,
            color: updatedLabel.color
          } : label
        ));
      }
    } catch (error) {
      console.error('Failed to update label:', error);
    }
  };

  const handleDeleteLabel = async (labelId: string) => {
    try {
      console.log('Deleting label with ID:', labelId);
      const response = await contactsApi.labels[labelId].delete();
      console.log('Delete label response:', response);
      
      if (response.status === 200) {
        setLabels(labels.filter(label => label.id !== labelId));
      }
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

        {/* Debug information */}
        {loading ? (
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
