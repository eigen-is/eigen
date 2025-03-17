import { UserPlus } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { useState } from 'react';
import { mockLabels, Label } from '../../src/data/mockData';
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';

export function ContactsSidebar() {
  const [labels, setLabels] = useState<Label[]>(mockLabels);

  // Handle label operations
  const handleAddLabel = (labelData: Omit<Label, 'id'>) => {
    const newLabel: Label = {
      id: (labels.length + 1).toString(),
      name: labelData.name,
      color: labelData.color,
    };
    setLabels([...labels, newLabel]);
  };

  const handleEditLabel = (updatedLabel: Label) => {
    setLabels(labels.map(label => 
      label.id === updatedLabel.id ? updatedLabel : label
    ));
  };

  const handleDeleteLabel = (labelId: string) => {
    setLabels(labels.filter(label => label.id !== labelId));
  };

  // Generate path for a label
  const getLabelPath = (label: Label) => `/contacts/label/${label.id.toLowerCase()}`;

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
              to="/c/all"
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
              activeOptions={{ exact: false }}
            >
              <span>All contacts</span>
            </Link>
            <Link
              to="/c/frequent"
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <span>Frequent</span>
            </Link>
            <Link
              to="/c/recent"
              className='flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer'
              activeProps={{
                className: 'bg-primary/10 text-primary',
              }}
              inactiveProps={{
                className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
              }}
            >
              <span>Recent</span>
            </Link>
          </nav>
        </div>

        {/* Use the shared LabelManager component */}
        <LabelManager
          labels={labels}
          onAddLabel={handleAddLabel}
          onEditLabel={handleEditLabel}
          onDeleteLabel={handleDeleteLabel}
          getLabelPath={getLabelPath}
        />
      </div>
    </div>
  );
}
