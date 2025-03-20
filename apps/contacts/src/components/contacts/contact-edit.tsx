import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Button } from "@workspace/ui/components/button";
import { type Contact } from "@apps/api-server/types/contact";
import { useLabels } from '../../hooks/use-labels';
import { useAddContact, useUpdateContact } from '../../hooks/use-contacts';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@workspace/ui/components/form";
import { Input } from "@workspace/ui/components/input";
import { Textarea } from "@workspace/ui/components/textarea";
import { 
  ArrowLeft, 
  Calendar,
  Plus,
  Trash
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { Calendar as CalendarComponent } from "@workspace/ui/components/calendar";
import { format } from "date-fns";
import { cn } from "@workspace/ui/lib/utils";
import { Badge } from "@workspace/ui/components/badge";

// Define the form schema
export const formSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  email: z.array(z.string().email().or(z.string().length(0))),
  phone: z.array(z.string()),
  address: z.array(
    z.object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
    })
  ),
  birthday: z.date().nullable(),
  notes: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

export type ContactFormValues = z.infer<typeof formSchema>;

interface ContactEditProps {
  contact: Contact;
  onSave: (data: ContactFormValues) => void;
  onCancel: () => void;
  filterType: string;
  filterId: string;
}

export function ContactEdit({ 
  contact, 
  onSave, 
  onCancel
}: ContactEditProps) {
  // Gebruik useLabels hook voor het ophalen van labels
  const { data: labels = [], error: labelsError } = useLabels();
  
  // Gebruik TanStack Query mutatie hooks voor het toevoegen/bijwerken van contacten
  const addContactMutation = useAddContact();
  const updateContactMutation = useUpdateContact();
  
  // State voor loading en error
  const [error, setError] = useState<string | null>(null);

  // Set up react-hook-form
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: contact?.firstName || "",
      lastName: contact?.lastName || "",
      company: contact?.company || "",
      jobTitle: contact?.jobTitle || "",
      email: contact?.email || [""],
      phone: contact?.phone || [""],
      address: contact?.address?.length ? contact.address : [{}],
      birthday: contact?.birthday ? new Date(contact.birthday) : null,
      notes: contact?.notes || "",
      labels: contact?.labels || []
    },
  });
  
  // Get the handleSubmit function from react-hook-form
  const { handleSubmit: hookFormSubmit } = form;
  
  // Function to handle form submission
  const handleSubmit = hookFormSubmit(async (data) => {
    setError(null);
    try {
      // Call the onSave callback with the form data
      await onSave(data);
    } catch (e) {
      // Handle any errors that might occur during save
      console.error("Error saving contact:", e);
      setError("An error occurred while saving the contact.");
    }
  });
  
  // Status bepaling voor loading
  const isLoading = addContactMutation.isPending || updateContactMutation.isPending;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center h-12 px-4 border-b">
        <Button variant="ghost" size="icon" onClick={onCancel} className="mr-2 h-8 w-8">
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">Back</span>
        </Button>
        <h1 className="font-medium">{contact.id ? 'Edit Contact' : 'Create Contact'}</h1>
      </div>
      
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md mb-4">
            {error}
          </div>
        )}
        
        {labelsError && (
          <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md mb-4">
            Er is een fout opgetreden bij het laden van labels.
          </div>
        )}
        
        <div className="space-y-8 pb-20">
          <Form {...form}>
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Basic Info Section */}
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium">Basic Information</h3>
                  <p className="text-sm text-muted-foreground">
                    Update your basic contact information.
                  </p>
                </div>
                
                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="firstName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>First name</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <FormField
                      control={form.control}
                      name="lastName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Last name</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="company"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Company</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <FormField
                      control={form.control}
                      name="jobTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Job title</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                                    
                  {/* Labels */}
                  <FormField
                    control={form.control}
                    name="labels"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Labels</FormLabel>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {field.value?.map((labelId, index) => {
                            const labelObj = labels.find(l => l.id === labelId);
                            return (
                            <Badge key={index} 
                              className="px-3 py-1" 
                              style={{ backgroundColor: labelObj?.color || '#3b82f6', color: '#fff' }}
                            >
                              {labelObj?.name}
                              <button 
                                type="button" 
                                className="ml-1 hover:text-destructive"
                                onClick={() => {
                                  const newLabels = [...field.value || []];
                                  newLabels.splice(index, 1);
                                  field.onChange(newLabels);
                                }}
                              >
                                <Trash className="h-3 w-3" />
                              </button>
                            </Badge>
                          )})}
                          <select 
                            className="h-7 w-auto rounded-md border border-input px-2 py-1 text-xs shadow-sm"
                            onChange={(e) => {
                              if (e.target.value && !field.value?.includes(e.target.value)) {
                                field.onChange([...field.value || [], e.target.value]);
                              }
                              e.target.value = "";
                            }}
                            defaultValue=""
                            disabled={isLoading}
                          >
                            <option value="" disabled>Add label</option>
                            {labels.map((label) => (
                              <option 
                                key={label.id} 
                                value={label.id}
                                disabled={field.value?.includes(label.id)}
                              >
                                {label.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
              
              {/* Contact Information Section */}
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium">Contact Information</h3>
                  <p className="text-sm text-muted-foreground">
                    Manage how people can reach this contact.
                  </p>
                </div>
                
                <div className="grid gap-6">
                  {/* Email Fields */}
                  <div>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-base">Email Addresses</FormLabel>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1"
                        onClick={() => {
                          const currentEmails = form.getValues("email");
                          form.setValue("email", [...currentEmails, ""]);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="text-xs">Add</span>
                      </Button>
                    </div>
                    <div className="grid gap-3 mt-2">
                      {form.watch("email").map((_, index) => (
                        <div key={index} className="flex gap-2 items-center">
                          <FormField
                            control={form.control}
                            name={`email.${index}`}
                            render={({ field }) => (
                              <FormItem className="flex-1 space-y-0">
                                <FormControl>
                                  <Input 
                                    {...field} 
                                    placeholder="Email address" 
                                  />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                          
                          {form.watch("email").length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => {
                                const currentEmails = form.getValues("email");
                                const newEmails = [...currentEmails];
                                newEmails.splice(index, 1);
                                form.setValue("email", newEmails);
                              }}
                            >
                              <Trash className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Phone Fields */}
                  <div>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-base">Phone Numbers</FormLabel>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1"
                        onClick={() => {
                          const currentPhones = form.getValues("phone");
                          form.setValue("phone", [...currentPhones, ""]);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="text-xs">Add</span>
                      </Button>
                    </div>
                    <div className="grid gap-3 mt-2">
                      {form.watch("phone").map((_, index) => (
                        <div key={index} className="flex gap-2 items-center">
                          <FormField
                            control={form.control}
                            name={`phone.${index}`}
                            render={({ field }) => (
                              <FormItem className="flex-1 space-y-0">
                                <FormControl>
                                  <Input 
                                    {...field} 
                                    placeholder="Phone number" 
                                  />
                                </FormControl>
                              </FormItem>
                            )}
                          />
                          
                          {form.watch("phone").length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => {
                                const currentPhones = form.getValues("phone");
                                const newPhones = [...currentPhones];
                                newPhones.splice(index, 1);
                                form.setValue("phone", newPhones);
                              }}
                            >
                              <Trash className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Address Fields */}
                  <div>
                    <div className="flex items-center justify-between">
                      <FormLabel className="text-base">Addresses</FormLabel>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1"
                        onClick={() => {
                          const currentAddresses = form.getValues("address");
                          form.setValue("address", [...currentAddresses, {}]);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="text-xs">Add</span>
                      </Button>
                    </div>
                    <div className="grid gap-4 mt-2">
                      {form.watch("address").map((_, index) => (
                        <div key={index} className="border rounded-lg p-4 space-y-3">
                          <div className="flex justify-between items-center">
                            <p className="text-sm font-medium">Address {index + 1}</p>
                            {form.watch("address").length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => {
                                  const currentAddresses = form.getValues("address");
                                  if (currentAddresses.length > 1) {
                                    const newAddresses = [...currentAddresses];
                                    newAddresses.splice(index, 1);
                                    form.setValue("address", newAddresses);
                                  }
                                }}
                              >
                                <Trash className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                          
                          <FormField
                            control={form.control}
                            name={`address.${index}.street`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Street</FormLabel>
                                <FormControl>
                                  <Input {...field} placeholder="Street address" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          
                          <div className="grid grid-cols-2 gap-3">
                            <FormField
                              control={form.control}
                              name={`address.${index}.city`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>City</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder="City" />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            
                            <FormField
                              control={form.control}
                              name={`address.${index}.state`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>State</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder="State/Province" />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>
                          
                          <div className="grid grid-cols-2 gap-3">
                            <FormField
                              control={form.control}
                              name={`address.${index}.zip`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Postal code</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder="Postal/ZIP code" />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            
                            <FormField
                              control={form.control}
                              name={`address.${index}.country`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Country</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder="Country" />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Additional Information Section */}
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium">Additional Information</h3>
                  <p className="text-sm text-muted-foreground">
                    Add extra details about this contact.
                  </p>
                </div>
                
                <div className="grid gap-4">
                  {/* Birthday */}
                  <FormField
                    control={form.control}
                    name="birthday"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>Birthday</FormLabel>
                        <Popover>
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button
                                variant="outline"
                                className={cn(
                                  "w-full justify-start text-left font-normal",
                                  !field.value && "text-muted-foreground"
                                )}
                              >
                                <Calendar className="mr-2 h-4 w-4" />
                                {field.value ? (
                                  format(field.value, "PPP")
                                ) : (
                                  <span>Pick a date</span>
                                )}
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <CalendarComponent
                              mode="single"
                              selected={field.value || undefined}
                              onSelect={field.onChange}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  {/* Notes */}
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Textarea rows={4} {...field} placeholder="Add notes about this contact" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
              
              <div className="flex gap-4 justify-end">
                <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? 'Saving...' : 'Save changes'}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
