import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Button } from "@workspace/ui/components/button";
import { Label } from './types';

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

interface DeleteConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmDelete: () => void;
}

export function DeleteConfirmationDialog({
  open,
  onOpenChange,
  onConfirmDelete,
}: DeleteConfirmationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Delete Label</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this label? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirmDelete}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedLabel: Label | null;
  onSubmit: (data: LabelFormValues) => void;
  onDelete: () => void;
}

export function LabelDialog({
  open,
  onOpenChange,
  selectedLabel,
  onSubmit,
  onDelete,
}: LabelDialogProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const form = useForm<LabelFormValues>({
    resolver: zodResolver(labelFormSchema),
    defaultValues: {
      name: selectedLabel?.name || "",
      color: selectedLabel?.color || "#3b82f6", // Default blue color
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{selectedLabel ? 'Edit Label' : 'Create Label'}</DialogTitle>
            <DialogDescription>
              {selectedLabel 
                ? 'Update the name and color of your label.' 
                : 'Create a new label to organize your items.'}
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
              <DialogFooter className="flex justify-between sm:justify-between">
                {selectedLabel && (
                  <Button 
                    type="button" 
                    variant="outline"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setDeleteDialogOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                )}
                <Button type="submit">{selectedLabel ? 'Save changes' : 'Create label'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      
      <DeleteConfirmationDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirmDelete={onDelete}
      />
    </>
  );
}
