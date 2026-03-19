import {z} from 'zod';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {useEffect, useRef, useState} from 'react';
import {Camera, InfoIcon} from 'lucide-react';
import {useMeContact, useUpdateContact} from '@workspace/lib/contacts';
import {useAuth} from '@workspace/lib/auth';
import {useUpload} from '@workspace/ui/components/layout/upload-provider/upload-provider';
import {uploadWithProgress} from "@workspace/ui/components/layout/upload-provider/upload-with-progress";
import {getContactsAvatarUploadUrl} from "@workspace/lib/api";
import {UserAvatar} from "@workspace/ui";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage} from "@workspace/ui/components/form";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {useNavigate} from '@tanstack/react-router';

const formSchema = z.object({
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
});

export type ProfileFormValues = z.infer<typeof formSchema>;

export function ProfileEditor() {
    const {user} = useAuth();
    const {data: contact, isLoading, error: fetchError} = useMeContact();
    const [avatar, setAvatar] = useState<string | null>(null);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const initializedRef = useRef(false);

    const upload = useUpload();
    const updateContactMutation = useUpdateContact();

    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            firstName: "",
            lastName: "",
        },
    });

    useEffect(() => {
        if (contact && !initializedRef.current) {
            initializedRef.current = true;
            form.reset({
                firstName: contact.firstName || "",
                lastName: contact.lastName || "",
            });
            setAvatar(contact.avatar || null);
        }
    }, [contact, form]);

    const navigate = useNavigate();

    const handleSubmit = form.handleSubmit(async (data) => {
        if (!contact) return;

        try {
            const updateData = {
                ...contact,
                firstName: data.firstName,
                lastName: data.lastName || "",
                avatar: avatar || ""
            };

            await updateContactMutation.mutateAsync(updateData);

            setSubmitError(null);

            await navigate({to: '/'});
        } catch (err) {
            console.error('Error updating profile:', err);
            setSubmitError('Failed to update your profile. Please try again.');
        }
    });

    if (isLoading && !contact) {
        return <div className="flex justify-center items-center h-64">Loading your profile...</div>;
    }

    if (fetchError && !contact) {
        return (
            <div className="flex justify-center items-center h-64 text-destructive">
                Failed to load your profile information. Please try again.
            </div>
        );
    }

    return (<>
            {submitError && (
                <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-md">
                    {submitError}
                </div>
            )}

            <Form {...form}>
                <form onSubmit={handleSubmit} className="space-y-8">
                    <div className="flex justify-center mb-8">
                        <div className="h-32 w-32 relative group">
                            <UserAvatar
                                name={contact ? `${contact.firstName} ${contact.lastName}` : ""}
                                email={contact?.email?.[0]}
                                imageUrl={avatar || ""}
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
                                    if (file) {
                                        const formData = new FormData();
                                        formData.append('file', file);

                                        const uploadHandler = upload.createUpload(file.name);

                                        try {
                                            await uploadWithProgress({
                                                url: getContactsAvatarUploadUrl(user?.id || ''),
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
                                                }
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
                                        <Camera className="h-4 w-4"/>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => {
                                        fileInputRef.current?.click();
                                    }}>
                                        Upload from files
                                    </DropdownMenuItem>
                                    {avatar && (
                                        <DropdownMenuItem onSelect={() => {
                                            setAvatar(null);
                                        }}>
                                            Remove avatar
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                        <FormField
                            control={form.control}
                            name="firstName"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>First Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="Enter your first name" {...field} />
                                    </FormControl>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="lastName"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>Last Name</FormLabel>
                                    <FormControl>
                                        <Input placeholder="Enter your last name" {...field} />
                                    </FormControl>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />
                    </div>
                    <div className="bg-accent border text-accent-foreground rounded-md p-4">
                        <div className="flex">
                            <InfoIcon className="h-5 w-5 text-primary mr-2"/>
                            <div>
                                <h3 className="font-medium">Important</h3>
                                <p className="text-sm">
                                    Your profile picture and name are public information visible to other users.
                                    These details may appear in shared workspaces, messages, and documents throughout
                                    eigen.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button type="submit" disabled={updateContactMutation.isPending} className="w-full sm:w-auto">
                            {updateContactMutation.isPending ? "Saving..." : "Save Changes"}
                        </Button>
                    </div>
                </form>
            </Form>
        </>
    );
}
