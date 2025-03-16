import { useState } from 'react';
import { PlusIcon, Pencil } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { LabelDialog } from './label-dialog';
import { Label, LabelManagerProps } from './types';

export function LabelManager({
  labels,
  onAddLabel,
  onEditLabel,
  onDeleteLabel,
  getLabelPath = (label) => `/label/${label.id.toLowerCase()}`,
  className,
}: LabelManagerProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleAddLabel = () => {
    setSelectedLabel(null);
    setDialogOpen(true);
  };

  const handleEditClick = (label: Label) => {
    setSelectedLabel(label);
    setDialogOpen(true);
  };

  const handleSubmit = (data: { name: string; color: string }) => {
    if (selectedLabel) {
      // Edit existing label
      onEditLabel({
        ...selectedLabel,
        name: data.name,
        color: data.color,
      });
    } else {
      // Add new label
      onAddLabel({
        name: data.name,
        color: data.color,
      });
    }
    setDialogOpen(false);
  };

  const handleDeleteLabel = () => {
    if (selectedLabel) {
      onDeleteLabel(selectedLabel.id);
      setDialogOpen(false);
    }
  };

  return (
    <div className={cn("px-6 py-2", className)}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground px-3">Labels</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleAddLabel}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            <span className="sr-only">Add new label</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 w-7 p-0", isEditMode && "bg-muted")}
            onClick={() => setIsEditMode(!isEditMode)}
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="sr-only">Toggle edit mode</span>
          </Button>
        </div>
      </div>
      
      <div className="space-y-1">
        {labels.map((label) => (
          <div key={label.id} className="flex items-center justify-between">
            <Link
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground grow cursor-pointer"
              to={getLabelPath(label)}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
              <span>{label.name}</span>
            </Link>
            {isEditMode && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => handleEditClick(label)}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="sr-only">Edit {label.name}</span>
              </Button>
            )}
          </div>
        ))}
      </div>

      <LabelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedLabel={selectedLabel}
        onSubmit={handleSubmit}
        onDelete={handleDeleteLabel}
      />
    </div>
  );
}
