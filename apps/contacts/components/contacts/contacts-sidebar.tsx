import { PlusIcon, Pencil, UserPlus, Tag } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { useState } from 'react';
import { mockLabels, Label } from '../../src/data/mockData';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@workspace/ui/components/form";
import { Input } from "@workspace/ui/components/input";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

// Form schema for label management
const labelFormSchema = z.object({
  name: z.string().min(1, {
    message: "Label name is required.",
  }),
  color: z.string().min(1, {
    message: "Color is required.",
  }),
});

type LabelFormValues = z.infer<typeof labelFormSchema>;

export function ContactsSidebar() {
  const [labels, setLabels] = useState<Label[]>(mockLabels);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const form = useForm<LabelFormValues>({
    resolver: zodResolver(labelFormSchema),
    defaultValues: {
      name: "",
      color: "#3b82f6", // Default blue color
    },
  });

  const onSubmit = (data: LabelFormValues) => {
    if (selectedLabel) {
      // Update existing label
      setLabels(labels.map(label => 
        label.id === selectedLabel.id 
          ? { ...label, name: data.name, color: data.color }
          : label
      ));
    } else {
      // Add new label
      const newLabel: Label = {
        id: (labels.length + 1).toString(),
        name: data.name,
        color: data.color,
      };
      setLabels([...labels, newLabel]);
    }
    setDialogOpen(false);
    form.reset();
  };

  const handleEditClick = (label: Label) => {
    setSelectedLabel(label);
    form.reset({
      name: label.name,
      color: label.color,
    });
    setDialogOpen(true);
  };

  const handleAddLabel = () => {
    setSelectedLabel(null);
    form.reset({
      name: "",
      color: "#3b82f6",
    });
    setDialogOpen(true);
  };

  return (
    <div className="w-64 border-r h-full flex flex-col bg-background">
      <div className="p-4">
        <Link to="/contacts">
          <Button className="w-full justify-start gap-2" size="lg">
            <UserPlus className="h-4 w-4" />
            Create contact
          </Button>
        </Link>
      </div>

      <div className="overflow-auto flex-1">
        <div className="px-3 py-2">
          <nav className="space-y-1">
            <Link
              to="/contacts"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer"
              activeProps={{
                className: "bg-primary/10 text-primary",
              }}
              inactiveProps={{
                className: "text-muted-foreground hover:bg-muted hover:text-foreground",
              }}
              activeOptions={{ exact: true }}
            >
              <span>All contacts</span>
            </Link>
            <Link
              to="/contacts/frequent"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer"
              activeProps={{
                className: "bg-primary/10 text-primary",
              }}
              inactiveProps={{
                className: "text-muted-foreground hover:bg-muted hover:text-foreground",
              }}
            >
              <span>Frequent</span>
            </Link>
            <Link
              to="/contacts/recent"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer"
              activeProps={{
                className: "bg-primary/10 text-primary",
              }}
              inactiveProps={{
                className: "text-muted-foreground hover:bg-muted hover:text-foreground",
              }}
            >
              <span>Recent</span>
            </Link>
          </nav>
        </div>

        <div className="px-6 py-2">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-xs font-semibold text-muted-foreground px-3">Labels</h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setIsEditMode(!isEditMode)}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span className="sr-only">Toggle edit mode</span>
            </Button>
          </div>
          
          <div className="space-y-1">
            {labels.map((label) => (
              <div key={label.id} className="flex items-center">
                <Link
                  className={cn(
                    "flex flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer",
                    isEditMode && "mr-2"
                  )}
                  to={`/contacts/label/${label.id}`}
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
            
            {isEditMode && (
              <Button
                variant="ghost"
                size="sm"
                className="flex w-full items-center justify-start px-3 py-2 text-sm"
                onClick={handleAddLabel}
              >
                <PlusIcon className="mr-2 h-4 w-4" />
                Add new label
              </Button>
            )}
            
            <Link
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
              to='/contacts/labels'
            >
              <Tag className="h-4 w-4" />
              <span>Manage Labels</span>
            </Link>
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{selectedLabel ? 'Edit Label' : 'Create Label'}</DialogTitle>
            <DialogDescription>
              {selectedLabel 
                ? 'Update the name and color of your label.' 
                : 'Create a new label to organize your contacts.'}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Enter label name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="color"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Color</FormLabel>
                    <div className="flex items-center gap-2">
                      <div 
                        className="h-6 w-6 rounded-full border" 
                        style={{ backgroundColor: field.value }}
                      />
                      <FormControl>
                        <Input type="color" {...field} />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">{selectedLabel ? 'Save changes' : 'Create label'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
