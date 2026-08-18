import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useMeContact, useUpdateContact } from '@workspace/lib/contacts';
import { AvatarEditor, ErrorState, LoadingState, useContactAvatarUpload } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { InfoIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const formSchema = z.object({
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().optional(),
});

type ProfileFormValues = z.infer<typeof formSchema>;

export function ProfileEditor() {
    const { data: contact, isLoading, error: fetchError } = useMeContact();
    const [avatar, setAvatar] = useState<string | null>(null);
    // Captured alongside the field values when the form first initializes, so the save submits the etag it
    // loaded rather than one a later refetch advanced past — pairing a stale form with a fresh etag would clobber.
    // Empty until the profile has loaded; a stored card's etag is never empty, so it doubles as the seeded flag.
    const loadedEtagRef = useRef('');

    const uploadAvatar = useContactAvatarUpload(setAvatar);
    const updateContactMutation = useUpdateContact();

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            firstName: '',
            lastName: '',
        },
    });

    useEffect(() => {
        if (!contact) return;
        // Seed once on first load, and re-seed whenever a refetch (e.g. after a 412 recovery) advances the etag
        // past the frozen snapshot — otherwise the form keeps stale fields + a stale etag and the next save
        // 412s again, an unbreakable loop.
        if (contact.etag === loadedEtagRef.current) return;
        loadedEtagRef.current = contact.etag;
        form.reset({
            firstName: contact.firstName || '',
            lastName: contact.lastName || '',
        });
        setAvatar(contact.avatar || null);
    }, [contact, form]);

    const navigate = useNavigate();

    const handleSubmit = form.handleSubmit(async (data) => {
        if (!contact) return;

        await updateContactMutation.mutateAsync({
            ...contact,
            firstName: data.firstName,
            lastName: data.lastName || '',
            avatar: avatar || '',
            etag: loadedEtagRef.current,
        });
        await navigate({ to: '/' });
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
                        name={contact ? `${contact.firstName} ${contact.lastName}` : ''}
                        email={contact?.email?.[0]}
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
                                <FormLabel>First Name</FormLabel>
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
                                <FormLabel>Last Name</FormLabel>
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
