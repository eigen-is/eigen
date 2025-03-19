import { useState, useRef, useEffect } from 'react';
import { PlusIcon, Pencil } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "../../../components/button";
import { cn } from "../../../lib/utils";
import { LabelDialog } from './label-dialog';
import { LabelManagerProps } from './types';
import { SidebarItem } from '../sidebar';
import type { Label } from "@apps/api-server/types/label";

export function LabelManager({
  labels,
  onAddLabel,
  onEditLabel,
  onDeleteLabel,
  getLabelPath = (label) => `/label/${label.id.toLowerCase()}`,
  className,
  condensed = false,
}: LabelManagerProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const labelManagerRef = useRef<HTMLDivElement>(null);
  
  // Handle clicks outside of the label manager to exit edit mode
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Skip if we're not in edit mode or if the dialog is open
      if (!isEditMode || dialogOpen) return;
      
      // Check if the click was outside the label manager
      if (labelManagerRef.current && !labelManagerRef.current.contains(event.target as Node)) {
        setIsEditMode(false);
      }
    };

    // Add event listener
    document.addEventListener('mousedown', handleClickOutside);
    
    // Clean up
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditMode, dialogOpen]);

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
    <div className={cn("py-2", className)} ref={labelManagerRef}>
      <div className={cn(
        "flex items-center mb-2",
        condensed ? "justify-center" : "justify-between"
      )}>
        {!condensed && <h3 className="text-xs font-semibold text-muted-foreground px-3">Labels</h3>}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleAddLabel}
            className="h-8 w-8"
          >
            <PlusIcon className="h-4 w-4" />
            <span className="sr-only">Add new label</span>
          </Button>
          {!condensed && (
            <Button
              variant={isEditMode ? "secondary" : "ghost"}
              size="icon"
              className={cn("h-8 w-8", isEditMode && "border border-primary")}
              onClick={() => setIsEditMode(!isEditMode)}
            >
              <Pencil className={cn("h-4 w-4", isEditMode && "text-primary")} />
              <span className="sr-only">Toggle edit mode</span>
            </Button>
          )}
        </div>
      </div>
      
      <div className="space-y-1">
        {labels.map((label) => (
          <SidebarItem
            key={label.id}
            icon={<></>}
            label={label.name}
            colorDot={label.color}
            to={getLabelPath(label)}
            condensed={condensed}
            className={isEditMode && !condensed ? "pr-8 relative" : ""}
          >
            {isEditMode && !condensed && (
              <div className="absolute right-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleEditClick(label);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
            )}
          </SidebarItem>
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
