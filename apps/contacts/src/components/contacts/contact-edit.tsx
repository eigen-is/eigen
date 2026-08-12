import { zodResolver } from '@hookform/resolvers/zod';
import { useLabels } from '@workspace/lib/contacts';
import { formatInputDate } from '@workspace/lib/date';
import type { Contact } from '@workspace/lib/types/contact';
import { AvatarEditor, Toolbar, useContactAvatarUpload } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Textarea } from '@workspace/ui/components/textarea';
import { Plus, Trash2 } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

// Define the form schema
const formSchema = z
    .object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
        email: z.array(z.email().or(z.string().length(0))),
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
            <ToolbarTitle>{isNew ? 'Create Contact' : 'Edit Contact'}</ToolbarTitle>
        </Toolbar>
    );
}

type RepeatableFieldProps = {
    label: React.ReactNode;
    onAdd: () => void;
    children: React.ReactNode;
};

function RepeatableField({ label, onAdd, children }: RepeatableFieldProps) {
    return (
        <div>
            <div className="flex items-center justify-between">
                <FormLabel className="text-base">{label}</FormLabel>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={onAdd}>
                    <Plus className="h-3.5 w-3.5" />
                    <span className="text-xs">Add</span>
                </Button>
            </div>
            <div className="grid gap-3 mt-2">{children}</div>
        </div>
    );
}

type ContactEditProps = {
    contact: Contact;
    onSave: (data: ContactFormValues) => void;
    onCancel: () => void;
};

export function ContactEdit({ contact, onSave, onCancel }: ContactEditProps) {
    const { data: labels = [], error: labelsError } = useLabels();
    const [avatar, setAvatar] = useState<string | null>(contact?.avatar ?? null);

    const uploadAvatar = useContactAvatarUpload(setAvatar);
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

    // `email`/`phone` are primitive string[] in the schema; react-hook-form v7's useFieldArray
    // generic expects array-of-objects, so the field name needs `as never`. Runtime-safe — kept
    // as string[] (not wrapped in {value} objects) to avoid changing the contact data shape.
    const {
        fields: emailFields,
        append: appendEmail,
        remove: removeEmail,
    } = useFieldArray({
        control: form.control,
        name: 'email' as never,
    });
    const {
        fields: phoneFields,
        append: appendPhone,
        remove: removePhone,
    } = useFieldArray({
        control: form.control,
        name: 'phone' as never,
    });
    const {
        fields: addressFields,
        append: appendAddress,
        remove: removeAddress,
    } = useFieldArray({
        control: form.control,
        name: 'address',
    });

    const handleSubmit = form.handleSubmit(async (data) => {
        await onSave({ ...data, avatar });
    });

    const isLoading = form.formState.isSubmitting;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto app-gutter">
                {labelsError && (
                    <div className="bg-destructive/15 text-destructive px-4 py-2 rounded-md mb-4">
                        An error occurred while loading labels.
                    </div>
                )}

                <div className="space-y-8 pb-20">
                    <Form {...form}>
                        <form onSubmit={handleSubmit} className="space-y-8">
                            <div className="flex justify-center mb-8">
                                <AvatarEditor
                                    name={`${contact.firstName} ${contact.lastName}`}
                                    email={contact.email?.[0]}
                                    imageUrl={avatar ?? ''}
                                    onRemove={avatar ? () => setAvatar(null) : undefined}
                                    onUpload={uploadAvatar}
                                />
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
                                                                    backgroundColor:
                                                                        labelObj?.color || 'var(--primary)',
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
                                    <RepeatableField
                                        label={
                                            <>
                                                Email Addresses
                                                <span className="text-muted-foreground">*</span>
                                            </>
                                        }
                                        onAdd={() => appendEmail('' as never)}
                                    >
                                        {emailFields.map((item, index) => (
                                            <div key={item.id} className="flex gap-2 items-center">
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
                                                {emailFields.length > 1 && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 w-7 p-0"
                                                        onClick={() => removeEmail(index)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        ))}
                                    </RepeatableField>

                                    <RepeatableField label="Phone Numbers" onAdd={() => appendPhone('' as never)}>
                                        {phoneFields.map((item, index) => (
                                            <div key={item.id} className="flex gap-2 items-center">
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
                                                {phoneFields.length > 1 && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 w-7 p-0"
                                                        onClick={() => removePhone(index)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        ))}
                                    </RepeatableField>

                                    <div>
                                        <div className="flex items-center justify-between">
                                            <FormLabel className="text-base">Addresses</FormLabel>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1"
                                                onClick={() => appendAddress({})}
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                <span className="text-xs">Add</span>
                                            </Button>
                                        </div>
                                        <div className="grid gap-4 mt-2">
                                            {addressFields.map((item, index) => (
                                                <div key={item.id} className="border rounded-lg p-4 space-y-3">
                                                    <div className="flex justify-between items-center">
                                                        <p className="text-sm font-medium">Address {index + 1}</p>
                                                        {addressFields.length > 1 && (
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 w-7 p-0"
                                                                onClick={() => removeAddress(index)}
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
                                                        defaultValue={field.value ? formatInputDate(field.value) : ''}
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
                                    {isLoading ? 'Saving...' : 'Save'}
                                </Button>
                            </div>
                        </form>
                    </Form>
                </div>
            </div>
        </div>
    );
}
