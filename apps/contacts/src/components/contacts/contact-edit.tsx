import { zodResolver } from '@hookform/resolvers/zod';
import { useLabels } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import { AvatarEditor, Toolbar, ToolbarTitle, useContactAvatarUpload } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { Textarea } from '@workspace/ui/components/textarea';
import { Plus, Trash2 } from 'lucide-react';
import type React from 'react';
import { useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

const formSchema = z
    .object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
        email: z.array(z.object({ value: z.email('Enter a valid email address').or(z.literal('')) })),
        phone: z.array(z.object({ value: z.string() })),
        address: z.array(
            z.object({
                street: z.string().optional(),
                city: z.string().optional(),
                state: z.string().optional(),
                zipCode: z.string().optional(),
                country: z.string().optional(),
            }),
        ),
        birthday: z.string().optional(),
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

// The form models email/phone as `{ value }[]` rather than the wire `string[]`: react-hook-form's
// useFieldArray reads the array through compact() (filter(Boolean)), so a blank primitive '' is stripped —
// the create form would open with zero rows and "Add" would collapse an all-blank list back to one row.
// Object entries are always truthy, so every row survives; onSave flattens back to string[], blanks filtered.
type FormValues = z.infer<typeof formSchema>;
export type ContactFormValues = Omit<FormValues, 'email' | 'phone'> & { email: string[]; phone: string[] };

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
    label: string;
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
    onSave: (data: ContactFormValues, etag: string) => void;
    onCancel: () => void;
};

export function ContactEdit({ contact, onSave, onCancel }: ContactEditProps) {
    const { data: labels = [], error: labelsError } = useLabels();
    const [avatar, setAvatar] = useState<string | null>(contact?.avatar ?? null);
    // Snapshot the etag from the same first-render contact that seeds the form fields below. The route's live
    // useContacts() copy is refetched by SSE, so reading its etag at submit would pair fresh-server etag with
    // stale field values and silently clobber a concurrent edit; this ref stays paired with the loaded fields.
    const loadedEtagRef = useRef(contact?.etag);

    const uploadAvatar = useContactAvatarUpload(setAvatar);
    const form = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            firstName: contact?.firstName || '',
            lastName: contact?.lastName || '',
            company: contact?.company || '',
            jobTitle: contact?.jobTitle || '',
            email: contact?.email?.length ? contact.email.map((value) => ({ value })) : [{ value: '' }],
            phone: contact?.phone?.length ? contact.phone.map((value) => ({ value })) : [{ value: '' }],
            address: contact?.address?.length ? contact.address : [{}],
            birthday: contact?.birthday || '',
            notes: contact?.notes || '',
            labels: contact?.labels || [],
        },
    });

    const {
        fields: emailFields,
        append: appendEmail,
        remove: removeEmail,
    } = useFieldArray({
        control: form.control,
        name: 'email',
    });
    const {
        fields: phoneFields,
        append: appendPhone,
        remove: removePhone,
    } = useFieldArray({
        control: form.control,
        name: 'phone',
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
        await onSave(
            {
                ...data,
                email: data.email.map((row) => row.value).filter(Boolean),
                phone: data.phone.map((row) => row.value).filter(Boolean),
                avatar,
            },
            loadedEtagRef.current,
        );
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
                                    <RepeatableField label="Email Addresses" onAdd={() => appendEmail({ value: '' })}>
                                        {emailFields.map((item, index) => (
                                            <FormField
                                                key={item.id}
                                                control={form.control}
                                                name={`email.${index}.value`}
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <div className="flex gap-2 items-center">
                                                            <FormControl>
                                                                <Input {...field} placeholder="Email address" />
                                                            </FormControl>
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
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
                                        ))}
                                    </RepeatableField>

                                    <RepeatableField label="Phone Numbers" onAdd={() => appendPhone({ value: '' })}>
                                        {phoneFields.map((item, index) => (
                                            <FormField
                                                key={item.id}
                                                control={form.control}
                                                name={`phone.${index}.value`}
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <div className="flex gap-2 items-center">
                                                            <FormControl>
                                                                <Input {...field} placeholder="Phone number" />
                                                            </FormControl>
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
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
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
                                                    <Input type="date" {...field} value={field.value || ''} />
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
