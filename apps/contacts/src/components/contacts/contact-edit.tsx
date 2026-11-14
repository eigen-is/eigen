// The form that creates or edits a contact: names, emails, phone numbers, addresses, labels, birthday and notes.
// Routes such as the new-contact route show it and save what it returns. A field the user changed stays, and every
// other field follows the contact it is given, so a sync or a refused Save moves only what nobody touched.

import { zodResolver } from '@hookform/resolvers/zod';
import { rethrowUntoasted } from '@workspace/lib/api-error';
import { useLabels } from '@workspace/lib/contacts';
import type { Contact, CreateContactInput } from '@workspace/lib/types/contact';
import { useHeldEtag } from '@workspace/lib/use-held-etag';
import { AvatarEditor } from '@workspace/ui/components/avatar-editor';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Toolbar, ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Textarea } from '@workspace/ui/components/textarea';
import { useContactAvatarUpload } from '@workspace/ui/components/use-contact-avatar-upload';
import { useFollowedFields } from '@workspace/ui/hooks/use-followed-fields';
import { cn } from '@workspace/ui/lib/utils';
import { Plus, Trash2 } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import type { Control } from 'react-hook-form';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

const formSchema = z
    .object({
        firstName: z.string(),
        lastName: z.string(),
        company: z.string(),
        jobTitle: z.string(),
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
        birthday: z.string(),
        notes: z.string(),
        labels: z.array(z.string()),
        avatar: z.string().nullable(),
    })
    .refine((data) => data.firstName.trim().length > 0 || data.lastName.trim().length > 0, {
        message: 'Either first name or last name is required',
        path: ['firstName'],
    });

// A row is `{ value }`, not the wire's string: useFieldArray reads a list through compact(), which strips a blank ''.
// A Save flattens the rows back, without the blanks.
type FormValues = z.infer<typeof formSchema>;

const FORM_FIELDS = formSchema.keyof().options;

type ContactEditToolbarProps = {
    isNew: boolean;
};

export function ContactEditToolbar({ isNew }: ContactEditToolbarProps) {
    return (
        <Toolbar>
            <ToolbarTitle>{isNew ? 'Create contact' : 'Edit contact'}</ToolbarTitle>
        </Toolbar>
    );
}

type ContactEditProps = {
    contact: Contact;
    onSave: (data: CreateContactInput, etag: string) => Promise<void>;
    onCancel: () => void;
};

export function ContactEdit({ contact, onSave, onCancel }: ContactEditProps) {
    const { data: labels = [], error: labelsError } = useLabels();
    const record = useMemo(() => formValues(contact), [contact]);
    const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: record });
    const typing = useFollowedFields(form, FORM_FIELDS, record);
    const { heldEtag, saveHeld } = useHeldEtag(contact.etag, typing);

    form.register('avatar');
    const avatar = form.watch('avatar');
    const setAvatar = (url: string | null) => form.setValue('avatar', url, { shouldDirty: true });
    const uploadAvatar = useContactAvatarUpload(setAvatar);

    const {
        fields: addressFields,
        append: appendAddress,
        remove: removeAddress,
    } = useFieldArray({
        control: form.control,
        name: 'address',
    });

    const handleSubmit = form.handleSubmit((data) =>
        saveHeld(() =>
            onSave(
                {
                    ...data,
                    email: data.email.map((row) => row.value).filter(Boolean),
                    phone: data.phone.map((row) => row.value).filter(Boolean),
                    avatar: data.avatar ?? '',
                },
                heldEtag,
            ),
        ).catch(rethrowUntoasted),
    );

    const { isSubmitting } = form.formState;

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
                                    email={contact.email[0]}
                                    imageUrl={avatar ?? ''}
                                    onRemove={avatar ? () => setAvatar(null) : undefined}
                                    onUpload={uploadAvatar}
                                />
                            </div>

                            <div className="space-y-6">
                                <div>
                                    <h3 className="text-lg font-medium">Basic information</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Update your basic contact information.
                                    </p>
                                </div>

                                <div className="grid gap-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <TextField control={form.control} name="firstName" label="First name" />
                                        <TextField control={form.control} name="lastName" label="Last name" />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <TextField control={form.control} name="company" label="Company" />
                                        <TextField control={form.control} name="jobTitle" label="Job title" />
                                    </div>

                                    <FormField
                                        control={form.control}
                                        name="labels"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>Labels</FormLabel>
                                                <div className="flex flex-wrap gap-2 mt-2">
                                                    {field.value.map((labelId, index) => {
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
                                                                    onClick={() =>
                                                                        field.onChange(field.value.toSpliced(index, 1))
                                                                    }
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
                                                                !field.value.includes(e.target.value)
                                                            ) {
                                                                field.onChange([...field.value, e.target.value]);
                                                            }
                                                            e.target.value = '';
                                                        }}
                                                        defaultValue=""
                                                        disabled={isSubmitting}
                                                    >
                                                        <option value="" disabled>
                                                            Add label
                                                        </option>
                                                        {labels.map((label) => (
                                                            <option
                                                                key={label.id}
                                                                value={label.id}
                                                                disabled={field.value.includes(label.id)}
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
                                    <h3 className="text-lg font-medium">Contact information</h3>
                                    <p className="text-sm text-muted-foreground">
                                        Manage how people can reach this contact.
                                    </p>
                                </div>

                                <div className="grid gap-6">
                                    <ValueRows
                                        control={form.control}
                                        name="email"
                                        label="Email addresses"
                                        placeholder="Email address"
                                    />
                                    <ValueRows
                                        control={form.control}
                                        name="phone"
                                        label="Phone numbers"
                                        placeholder="Phone number"
                                    />

                                    <RepeatableField
                                        label="Addresses"
                                        onAdd={() => appendAddress({})}
                                        className="gap-4"
                                    >
                                        {addressFields.map((item, index) => (
                                            <div key={item.id} className="border rounded-lg p-4 space-y-3">
                                                <div className="flex justify-between items-center">
                                                    <p className="text-sm font-medium">Address {index + 1}</p>
                                                    {addressFields.length > 1 && (
                                                        <RemoveRowButton onClick={() => removeAddress(index)} />
                                                    )}
                                                </div>

                                                <TextField
                                                    control={form.control}
                                                    name={`address.${index}.street`}
                                                    label="Street"
                                                    placeholder="Street address"
                                                />

                                                <div className="grid grid-cols-2 gap-3">
                                                    <TextField
                                                        control={form.control}
                                                        name={`address.${index}.city`}
                                                        label="City"
                                                        placeholder="City"
                                                    />
                                                    <TextField
                                                        control={form.control}
                                                        name={`address.${index}.state`}
                                                        label="State"
                                                        placeholder="State/Province"
                                                    />
                                                </div>

                                                <div className="grid grid-cols-2 gap-3">
                                                    <TextField
                                                        control={form.control}
                                                        name={`address.${index}.zipCode`}
                                                        label="Postal code"
                                                        placeholder="Postal/ZIP code"
                                                    />
                                                    <TextField
                                                        control={form.control}
                                                        name={`address.${index}.country`}
                                                        label="Country"
                                                        placeholder="Country"
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </RepeatableField>
                                </div>
                            </div>

                            <div className="space-y-6">
                                <div>
                                    <h3 className="text-lg font-medium">Additional information</h3>
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
                                                    <Input type="date" {...field} />
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
                                <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={isSubmitting}>
                                    {isSubmitting ? 'Saving...' : 'Save'}
                                </Button>
                            </div>
                        </form>
                    </Form>
                </div>
            </div>
        </div>
    );
}

function formValues(contact: Contact): FormValues {
    return {
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company || '',
        jobTitle: contact.jobTitle || '',
        email: contact.email.length ? contact.email.map((value) => ({ value })) : [{ value: '' }],
        phone: contact.phone.length ? contact.phone.map((value) => ({ value })) : [{ value: '' }],
        address: contact.address?.length ? contact.address : [{}],
        birthday: contact.birthday || '',
        notes: contact.notes || '',
        labels: contact.labels || [],
        avatar: contact.avatar ?? null,
    };
}

type TextFieldProps = {
    control: Control<FormValues>;
    name:
        | 'firstName'
        | 'lastName'
        | 'company'
        | 'jobTitle'
        | `address.${number}.${'street' | 'city' | 'state' | 'zipCode' | 'country'}`;
    label: string;
    placeholder?: string;
};

function TextField({ control, name, label, placeholder }: TextFieldProps) {
    return (
        <FormField
            control={control}
            name={name}
            render={({ field }) => (
                <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                        <Input {...field} value={field.value ?? ''} placeholder={placeholder} />
                    </FormControl>
                    <FormMessage />
                </FormItem>
            )}
        />
    );
}

type RepeatableFieldProps = {
    label: string;
    onAdd: () => void;
    className?: string;
    children: React.ReactNode;
};

function RepeatableField({ label, onAdd, className, children }: RepeatableFieldProps) {
    return (
        <div>
            <div className="flex items-center justify-between">
                <Label className="text-base">{label}</Label>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={onAdd}>
                    <Plus className="h-3.5 w-3.5" />
                    <span className="text-xs">Add</span>
                </Button>
            </div>
            <div className={cn('grid gap-3 mt-2', className)}>{children}</div>
        </div>
    );
}

type ValueRowsProps = {
    control: Control<FormValues>;
    name: 'email' | 'phone';
    label: string;
    placeholder: string;
};

function ValueRows({ control, name, label, placeholder }: ValueRowsProps) {
    const { fields, append, remove } = useFieldArray({ control, name });
    return (
        <RepeatableField label={label} onAdd={() => append({ value: '' })}>
            {fields.map((item, index) => (
                <FormField
                    key={item.id}
                    control={control}
                    name={`${name}.${index}.value`}
                    render={({ field }) => (
                        <FormItem>
                            <div className="flex gap-2 items-center">
                                <FormControl>
                                    <Input {...field} placeholder={placeholder} />
                                </FormControl>
                                {fields.length > 1 && <RemoveRowButton onClick={() => remove(index)} />}
                            </div>
                            <FormMessage />
                        </FormItem>
                    )}
                />
            ))}
        </RepeatableField>
    );
}

function RemoveRowButton({ onClick }: { onClick: () => void }) {
    return <TooltipButton icon={Trash2} tooltipText="Remove" type="button" className="h-7 w-7" onClick={onClick} />;
}
