import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { getContactById, mockLabels } from '../data/mockData';
import { useState } from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from "@workspace/ui/components/button";
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
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Mail, Phone, Building, MapPin, Calendar, ArrowLeft } from 'lucide-react';
import { Checkbox } from "@workspace/ui/components/checkbox";

// Form schema for contact edit
const contactFormSchema = z.object({
  firstName: z.string().min(1, {
    message: "First name is required.",
  }),
  lastName: z.string().min(1, {
    message: "Last name is required.",
  }),
  email: z.array(z.string().email()).optional(),
  phone: z.array(z.string()).optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  address: z.array(
    z.object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zipCode: z.string().optional(),
      country: z.string().optional(),
    })
  ).optional(),
  birthday: z.string().optional(),
  notes: z.string().optional(),
  labels: z.array(z.string()).default([]),
});

type ContactFormValues = z.infer<typeof contactFormSchema>;

export const Route = createFileRoute('/_auth/contacts/edit/$contactId')({
  component: EditContactRoute,
  validateParams: ({ params }) => {
    const contactId = params.contactId;
    const contact = getContactById(contactId);
    
    if (!contact) {
      throw redirect({
        to: '/contacts',
      });
    }
    
    return {
      contactId,
    };
  },
});

function EditContactRoute() {
  const { contactId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const contact = getContactById(contactId);
  
  if (!contact) {
    return null;
  }

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      jobTitle: contact.jobTitle,
      address: contact.address || [],
      birthday: contact.birthday,
      notes: contact.notes,
      labels: contact.labels,
    },
  });

  const onSubmit = (data: ContactFormValues) => {
    // In a real app, you would make an API call here
    console.log('Updated contact data:', data);
    navigate({ to: '/contacts/$contactId', params: { contactId } });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-4 p-4 border-b">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => navigate({ to: '/contacts/$contactId', params: { contactId } })}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <h1 className="text-xl font-semibold">Edit Contact</h1>
      </div>
      
      <div className="max-w-4xl mx-auto p-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
            {/* Basic Information Card */}
            <Card>
              <CardHeader>
                <CardTitle>Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First name</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter first name" {...field} />
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
                          <Input placeholder="Enter last name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="company"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Company</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter company" {...field} value={field.value || ''} />
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
                          <Input placeholder="Enter job title" {...field} value={field.value || ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <FormField
                  control={form.control}
                  name="birthday"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Birthday</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} value={field.value || ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
            
            {/* Contact Information Card */}
            <Card>
              <CardHeader>
                <CardTitle>Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Email Fields */}
                <div className="space-y-2">
                  <FormLabel className="flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Email Addresses
                  </FormLabel>
                  {form.watch('email')?.map((_, index) => (
                    <div key={index} className="flex gap-2">
                      <FormField
                        control={form.control}
                        name={`email.${index}`}
                        render={({ field }) => (
                          <FormItem className="flex-1">
                            <FormControl>
                              <Input placeholder="Enter email address" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const currentEmails = form.getValues('email') || [];
                          form.setValue('email', currentEmails.filter((_, i) => i !== index));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const currentEmails = form.getValues('email') || [];
                      form.setValue('email', [...currentEmails, '']);
                    }}
                  >
                    Add Email
                  </Button>
                </div>
                
                {/* Phone Fields */}
                <div className="space-y-2">
                  <FormLabel className="flex items-center gap-2">
                    <Phone className="h-4 w-4" />
                    Phone Numbers
                  </FormLabel>
                  {form.watch('phone')?.map((_, index) => (
                    <div key={index} className="flex gap-2">
                      <FormField
                        control={form.control}
                        name={`phone.${index}`}
                        render={({ field }) => (
                          <FormItem className="flex-1">
                            <FormControl>
                              <Input placeholder="Enter phone number" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const currentPhones = form.getValues('phone') || [];
                          form.setValue('phone', currentPhones.filter((_, i) => i !== index));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const currentPhones = form.getValues('phone') || [];
                      form.setValue('phone', [...currentPhones, '']);
                    }}
                  >
                    Add Phone
                  </Button>
                </div>
              </CardContent>
            </Card>
            
            {/* Address Card */}
            <Card>
              <CardHeader>
                <CardTitle>Addresses</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Tabs defaultValue="addresses" className="w-full">
                  <TabsList className="w-full">
                    <TabsTrigger 
                      value="addresses" 
                      className="flex-1"
                    >
                      Addresses
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="addresses" className="mt-4 space-y-4">
                    {form.watch('address')?.map((_, index) => (
                      <div key={index} className="space-y-4 p-4 border rounded-md">
                        <div className="flex justify-between items-center">
                          <h3 className="text-sm font-medium">
                            Address {index + 1}
                          </h3>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const currentAddresses = form.getValues('address') || [];
                              form.setValue('address', currentAddresses.filter((_, i) => i !== index));
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                        
                        <FormField
                          control={form.control}
                          name={`address.${index}.street`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Street</FormLabel>
                              <FormControl>
                                <Input placeholder="Enter street" {...field} value={field.value || ''} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <FormField
                            control={form.control}
                            name={`address.${index}.city`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>City</FormLabel>
                                <FormControl>
                                  <Input placeholder="Enter city" {...field} value={field.value || ''} />
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
                                <FormLabel>State/Province</FormLabel>
                                <FormControl>
                                  <Input placeholder="Enter state/province" {...field} value={field.value || ''} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                        
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <FormField
                            control={form.control}
                            name={`address.${index}.zipCode`}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Postal/Zip Code</FormLabel>
                                <FormControl>
                                  <Input placeholder="Enter postal/zip code" {...field} value={field.value || ''} />
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
                                  <Input placeholder="Enter country" {...field} value={field.value || ''} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      </div>
                    ))}
                    
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        const currentAddresses = form.getValues('address') || [];
                        form.setValue('address', [...currentAddresses, {}]);
                      }}
                    >
                      Add Address
                    </Button>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
            
            {/* Labels Card */}
            <Card>
              <CardHeader>
                <CardTitle>Labels</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                  {mockLabels.map(label => (
                    <FormField
                      key={label.id}
                      control={form.control}
                      name="labels"
                      render={({ field }) => (
                        <FormItem className="flex items-center space-x-2">
                          <FormControl>
                            <Checkbox
                              checked={field.value?.includes(label.id)}
                              onCheckedChange={(checked) => {
                                const currentLabels = field.value || [];
                                if (checked) {
                                  field.onChange([...currentLabels, label.id]);
                                } else {
                                  field.onChange(currentLabels.filter(id => id !== label.id));
                                }
                              }}
                            />
                          </FormControl>
                          <div className="flex items-center gap-2">
                            <span 
                              className="h-3 w-3 rounded-full" 
                              style={{ backgroundColor: label.color }} 
                            />
                            <FormLabel className="cursor-pointer">{label.name}</FormLabel>
                          </div>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
            
            {/* Notes Card */}
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea 
                          placeholder="Add notes about this contact" 
                          className="min-h-32" 
                          {...field} 
                          value={field.value || ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
            
            <CardFooter className="flex justify-end gap-2">
              <Button 
                type="button" 
                variant="outline"
                onClick={() => navigate({ to: '/contacts/$contactId', params: { contactId } })}
              >
                Cancel
              </Button>
              <Button type="submit">Save Contact</Button>
            </CardFooter>
          </form>
        </Form>
      </div>
    </div>
  );
}
