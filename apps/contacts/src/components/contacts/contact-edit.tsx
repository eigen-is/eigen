import { zodResolver } from '@hookform/resolvers/zod';
import { getContactsAvatarUploadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useLabels } from '@workspace/lib/contacts';
import { formatInputDate } from '@workspace/lib/date';
import type { Contact } from '@workspace/lib/types/contact';
import { Toolbar, UserAvatar } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { useUpload } from '@workspace/ui/components/layout/upload-provider/upload-provider';
import { uploadWithProgress } from '@workspace/ui/components/layout/upload-provider/upload-with-progress';
import { Textarea } from '@workspace/ui/components/textarea';
import { Camera, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

// Define the form schema
export const formSchema = z
    .object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
        email: z.array(z.string().email().or(z.string().length(0))),
        phone: z.array(z.string()),
        address: z.array(
            z.object({
                street: z.string().optional(),
                city: z.string().optional(),
                state: z.string().optional(),
                zipCode: z.string().optional(),
                country: z.string().optional(),
            }),
        ),
        birthday: z.date().nullable(),
        notes: z.string().optional(),
        labels: z.array(z.string()).optional(),
        avatar: z.string().nullable().optional(),
    })
    .refine(
        (data) =>
            (data.firstName ? data.firstName.trim().length > 0 : false) ||
            (data.lastName ? data.lastName.trim().length > 0 : false),
        {
            message: 'Either first name or last name is required',
            path: ['firstName'], // This will show the error on the firstName field
        },
    );

export type ContactFormValues = z.infer<typeof formSchema>;

type ContactEditToolbarProps = {
    isNew: boolean;
};

export function ContactEditToolbar({ isNew }: ContactEditToolbarProps) {
    return (
        <Toolbar>
            <h1 className="font-medium">{isNew ? 'Create Contact' : 'Edit Contact'}</h1>
        </Toolbar>
    );
}

type ContactEditProps = {
    contact: Contact;
    onSave: (data: ContactFormValues) => void;
    onCancel: () => void;
};

export function ContactEdit({ contact, onSave, onCancel }: ContactEditProps) {
    const { user } = useAuth();

    const { data: labels = [], error: labelsError } = useLabels();
    const [error, setError] = useState<string | null>(null);
    const [avatar, setAvatar] = useState<string | null>(contact?.avatar ?? null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const upload = useUpload();
    const form = useForm<ContactFormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            firstName: contact?.firstName || '',
            lastName: contact?.lastName || '',
            company: contact?.company || '',
            jobTitle: contact?.jobTitle || '',
            email: contact?.email || [''],
            phone: contact?.phone || [''],
            address: contact?.address?.length ? contact.address : [{}],
            birthday: contact?.birthday ? new Date(contact.birthday) : null,
            notes: contact?.notes || '',
            labels: contact?.labels || [],
        },
    });

    const { handleSubmit: hookFormSubmit } = form;
    const handleSubmit = hookFormSubmit(async (data) => {
        setError(null);
        try {
            await onSave({ ...data, avatar });
        } catch (e) {
            console.error('Error saving contact:', e);
            setError('An error occurred while saving the contact.');
        }
    });

    const isLoading = form.formState.isSubmitting;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-6">
                {error && <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md mb-4">{error}</div>}

                {labelsError && (
                    <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md mb-4">
                        An error occurred while loading labels.
                    </div>
                )}

                <div className="space-y-8 pb-20">
                    <Form {...form}>
                        <form onSubmit={handleSubmit} className="space-y-8">
                            <div className="flex justify-center mb-8">
                                <div className="h-32 w-32 relative group">
                                    <UserAvatar
                                        name={`${contact.firstName} ${contact.lastName}`}
                                        email={contact.email?.[0]}
                                        imageUrl={avatar ?? ''}
                                        className="h-full w-full"
                                        size="lg"
                                    />

                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={async (e) => {
                                            const file = e.target.files?.[0];
                                            if (!user) return;
                                            if (file) {
                                                const formData = new FormData();
                                                formData.append('file', file);

                                                const uploadHandler = upload.createUpload(file.name);

                                                try {
                                                    await uploadWithProgress({
                                                        url: getContactsAvatarUploadUrl(user.id),
                                                        formData,
                                                        onProgress: (progress: number) => {
                                                            uploadHandler.updateProgress(progress);
                                                        },
                                                        onSuccess: (response: string) => {
                                                            uploadHandler.complete();
                                                            setAvatar(response);
                                                        },
                                                        onError: (err) => {
                                                            uploadHandler.error();
                                                            console.error('Upload error:', err);
                                                        },
                                                    });
                                                } catch (err: unknown) {
                                                    console.error('Error uploading file:', err);
                                                    uploadHandler.error();
                                                }

                                                e.target.value = '';
                                            }
                                        }}
                                    />

                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                size="icon"
                                                variant="secondary"
                                                className="absolute bottom-1 right-1 rounded-full h-8 w-8 shadow-md opacity-80 hover:opacity-100"
                                            >
                                                <Camera className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                onSelect={() => {
                                                    fileInputRef.current?.click();
                                                }}
                                            >
                                                Upload from files
                                            </DropdownMenuItem>
                                            {avatar && (
                                                <DropdownMenuItem
                                                    onSelect={() => {
                                                        setAvatar(null);
                                                    }}
                                                >
                                                    Remove avatar
                                                </DropdownMenuItem>
                                            )}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>

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
                                                    <FormLabel>
                                                        First name<span className="text-muted-foreground">*</span>
                                                    </FormLabel>
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
                                                    <FormLabel>
                                                        Last name<span className="text-muted-foreground">*</span>
                                                    </FormLabel>
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
                                                        const labelObj = labels.find((l) => l.id === labelId);
                                                        return (
                                                            <Badge
                                                                key={index}
                                                                className="px-3 py-1 text-primary-foreground"
                                                                style={{
                                                                    backgroundColor: labelObj?.color || '#3b82f6',
                                                                }}
                                                            >
                                                                {labelObj?.name}
                                                                <button
                                                                    type="button"
                                                                    className="ml-1 hover:text-destructive"
                                                                    onClick={() => {
                                                                        const newLabels = [...(field.value || [])];
                                                                        newLabels.splice(index, 1);
                                                                        field.onChange(newLabels);
                                                                    }}
                                                                >
                                                                    <Trash2 className="h-3 w-3" />
                                                                </button>
                                                            </Badge>
                                                        );
                                                    })}
                                                    <select
                                                        className="h-7 w-auto rounded-md border border-input px-2 py-1 text-xs shadow-sm"
                                                        onChange={(e) => {
                                                            if (
                                                                e.target.value &&
                                                                !field.value?.includes(e.target.value)
                                                            ) {
                                                                field.onChange([
                                                                    ...(field.value || []),
                                                                    e.target.value,
                                                                ]);
                                                            }
                                                            e.target.value = '';
                                                        }}
                                                        defaultValue=""
                                                        disabled={isLoading}
                                                    >
                                                        <option value="" disabled>
                                                            Add label
                                                        </option>
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

                            <div className="space-y-6">
                                <div>
                                    <h3 className="text-lg font-medium">Contact Information</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Manage how people can reach this contact.
                                    </p>
                                </div>

                                <div className="grid gap-6">
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <FormLabel className="text-base">
                                                Email Addresses<span className="text-muted-foreground">*</span>
                                            </FormLabel>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1"
                                                onClick={() => {
                                                    const currentEmails = form.getValues('email');
                                                    form.setValue('email', [...currentEmails, '']);
                                                }}
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                <span className="text-xs">Add</span>
                                            </Button>
                                        </div>
                                        <div className="grid gap-3 mt-2">
                                            {form.watch('email').map((_, index) => (
                                                <div key={index} className="flex gap-2 items-center">
                                                    <FormField
                                                        control={form.control}
                                                        name={`email.${index}`}
                                                        render={({ field }) => (
                                                            <FormItem className="flex-1 space-y-0">
                                                                <FormControl>
                                                                    <Input {...field} placeholder="Email address" />
                                                                </FormControl>
                                                            </FormItem>
                                                        )}
                                                    />

                                                    {form.watch('email').length > 1 && (
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 w-7 p-0"
                                                            onClick={() => {
                                                                const currentEmails = form.getValues('email');
                                                                const newEmails = [...currentEmails];
                                                                newEmails.splice(index, 1);
                                                                form.setValue('email', newEmails);
                                                            }}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div>
                                        <div className="flex items-center justify-between">
                                            <FormLabel className="text-base">Phone Numbers</FormLabel>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1"
                                                onClick={() => {
                                                    const currentPhones = form.getValues('phone');
                                                    form.setValue('phone', [...currentPhones, '']);
                                                }}
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                <span className="text-xs">Add</span>
                                            </Button>
                                        </div>
                                        <div className="grid gap-3 mt-2">
                                            {form.watch('phone').map((_, index) => (
                                                <div key={index} className="flex gap-2 items-center">
                                                    <FormField
                                                        control={form.control}
                                                        name={`phone.${index}`}
                                                        render={({ field }) => (
                                                            <FormItem className="flex-1 space-y-0">
                                                                <FormControl>
                                                                    <Input {...field} placeholder="Phone number" />
                                                                </FormControl>
                                                            </FormItem>
                                                        )}
                                                    />

                                                    {form.watch('phone').length > 1 && (
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-7 w-7 p-0"
                                                            onClick={() => {
                                                                const currentPhones = form.getValues('phone');
                                                                const newPhones = [...currentPhones];
                                                                newPhones.splice(index, 1);
                                                                form.setValue('phone', newPhones);
                                                            }}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div>
                                        <div className="flex items-center justify-between">
                                            <FormLabel className="text-base">Addresses</FormLabel>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1"
                                                onClick={() => {
                                                    const currentAddresses = form.getValues('address');
                                                    form.setValue('address', [...currentAddresses, {}]);
                                                }}
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                <span className="text-xs">Add</span>
                                            </Button>
                                        </div>
                                        <div className="grid gap-4 mt-2">
                                            {form.watch('address').map((_, index) => (
                                                <div key={index} className="border rounded-lg p-4 space-y-3">
                                                    <div className="flex justify-between items-center">
                                                        <p className="text-sm font-medium">Address {index + 1}</p>
                                                        {form.watch('address').length > 1 && (
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 w-7 p-0"
                                                                onClick={() => {
                                                                    const currentAddresses = form.getValues('address');
                                                                    if (currentAddresses.length > 1) {
                                                                        const newAddresses = [...currentAddresses];
                                                                        newAddresses.splice(index, 1);
                                                                        form.setValue('address', newAddresses);
                                                                    }
                                                                }}
                                                            >
                                                                <Trash2 className="h-4 w-4" />
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
                                                                        <Input
                                                                            {...field}
                                                                            placeholder="State/Province"
                                                                        />
                                                                    </FormControl>
                                                                    <FormMessage />
                                                                </FormItem>
                                                            )}
                                                        />
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-3">
                                                        <FormField
                                                            control={form.control}
                                                            name={`address.${index}.zipCode`}
                                                            render={({ field }) => (
                                                                <FormItem>
                                                                    <FormLabel>Postal code</FormLabel>
                                                                    <FormControl>
                                                                        <Input
                                                                            {...field}
                                                                            value={field.value || ''}
                                                                            placeholder="Postal/ZIP code"
                                                                        />
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

                            <div className="space-y-6">
                                <div>
                                    <h3 className="text-lg font-medium">Additional Information</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Add extra details about this contact.
                                    </p>
                                </div>

                                <div className="grid gap-4">
                                    <FormField
                                        control={form.control}
                                        name="birthday"
                                        render={({ field }) => (
                                            <FormItem className="flex flex-col">
                                                <FormLabel>Birthday</FormLabel>

                                                <FormControl>
                                                    <Input
                                                        type="date"
                                                        value={field.value ? formatInputDate(field.value) : ''}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            field.onChange(val ? new Date(`${val}T00:00:00`) : null);
                                                        }}
                                                    />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />

                                    <FormField
                                        control={form.control}
                                        name="notes"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>Notes</FormLabel>
                                                <FormControl>
                                                    <Textarea
                                                        rows={4}
                                                        {...field}
                                                        placeholder="Add notes about this contact"
                                                    />
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
