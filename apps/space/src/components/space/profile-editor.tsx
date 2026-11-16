// The form that edits the user's name and avatar. Space's Personal info page shows it. It saves them to the
// user's own contact card, and then returns to Space's start page. A field the user changed stays, and every other
// field follows the card, so a sync or a refused Save moves only what nobody touched.

import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { rethrowUntoasted } from '@workspace/lib/api-error';
import { useMeContact, useUpdateContact } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import { contactFullName } from '@workspace/lib/types/contact';
import { useHeldEtag } from '@workspace/lib/use-held-etag';
import { AvatarEditor } from '@workspace/ui/components/avatar-editor';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { useContactAvatarUpload } from '@workspace/ui/components/use-contact-avatar-upload';
import { useFollowedFields } from '@workspace/ui/hooks/use-followed-fields';
import { InfoIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const formSchema = z.object({
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string(),
    avatar: z.string().nullable(),
});

type ProfileFormValues = z.infer<typeof formSchema>;

const FORM_FIELDS = formSchema.keyof().options;

export function ProfileEditor() {
    const { data: contact, isLoading, error: fetchError } = useMeContact();
    const updateContactMutation = useUpdateContact();
    const navigate = useNavigate();

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: { firstName: '', lastName: '', avatar: null },
    });

    const record = useMemo(() => (contact ? formValues(contact) : undefined), [contact]);
    const typing = useFollowedFields(form, FORM_FIELDS, record);
    const { heldEtag, saveHeld } = useHeldEtag(contact?.etag ?? '', typing);

    form.register('avatar');
    const avatar = form.watch('avatar');
    const setAvatar = (url: string | null) => form.setValue('avatar', url, { shouldDirty: true });
    const uploadAvatar = useContactAvatarUpload(setAvatar);

    const handleSubmit = form.handleSubmit(async (data) => {
        if (!contact) return;

        await saveHeld(async () => {
            await updateContactMutation.mutateAsync({
                ...contact,
                firstName: data.firstName,
                lastName: data.lastName,
                avatar: data.avatar || '',
                etag: heldEtag,
            });
            await navigate({ to: '/' });
        }).catch(rethrowUntoasted);
    });

    if (isLoading && !contact) {
        return <LoadingState />;
    }

    if (fetchError && !contact) {
        return <ErrorState message="Failed to load your profile information." />;
    }

    return (
        <Form {...form}>
            <form onSubmit={handleSubmit} className="space-y-8">
                <div className="flex justify-center mb-8">
                    <AvatarEditor
                        name={contact ? contactFullName(contact) : ''}
                        email={contact?.email[0]}
                        imageUrl={avatar || ''}
                        onRemove={avatar ? () => setAvatar(null) : undefined}
                        onUpload={uploadAvatar}
                    />
                </div>

                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <FormField
                        control={form.control}
                        name="firstName"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>First name</FormLabel>
                                <FormControl>
                                    <Input placeholder="Enter your first name" {...field} />
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
                                    <Input placeholder="Enter your last name" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                </div>
                <div className="bg-accent border text-accent-foreground rounded-md p-4">
                    <div className="flex">
                        <InfoIcon className="h-5 w-5 text-primary mr-2" />
                        <div>
                            <h3 className="font-medium">Important</h3>
                            <p className="text-sm">
                                Your profile picture and name are public information visible to other users. These
                                details may appear in shared workspaces, messages, and documents throughout eigen.
                            </p>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="submit" disabled={updateContactMutation.isPending} className="w-full sm:w-auto">
                        {updateContactMutation.isPending ? 'Saving...' : 'Save'}
                    </Button>
                </div>
            </form>
        </Form>
    );
}

function formValues(contact: Contact): ProfileFormValues {
    return {
        firstName: contact.firstName,
        lastName: contact.lastName,
        avatar: contact.avatar || null,
    };
}
