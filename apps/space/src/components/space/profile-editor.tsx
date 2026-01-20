import {z} from 'zod';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {useEffect, useRef, useState} from 'react';
import {Camera, InfoIcon} from 'lucide-react';
import {Contact} from "@workspace/lib/types/contact";
import {getMeContact, useUpdateContact} from '@workspace/lib/contacts';
import {toast} from 'sonner';
import {useUpload} from '@workspace/ui/components/layout/upload-provider/upload-provider';
import {uploadWithProgress} from "@workspace/ui/components/layout/upload-provider/upload-with-progress";
import {useQueryClient} from '@tanstack/react-query';
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

// Define the form schema - only include firstName, lastName
const formSchema = z.object({
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().optional(),
});

export type ProfileFormValues = z.infer<typeof formSchema>;

export function ProfileEditor() {
    const [contact, setContact] = useState<Contact | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [avatar, setAvatar] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const queryClient = useQueryClient();

    // Upload context for tracking upload progress
    const upload = useUpload();

    // Mutation for updating contact
    const updateContactMutation = useUpdateContact();

    // Fetch the user's contact information
    useEffect(() => {
        const fetchContact = async () => {
            try {
                setIsLoading(true);
                const userContact = await getMeContact();
                setContact(userContact);
                setAvatar(userContact?.avatar || null);
                setIsLoading(false);
            } catch (err) {
                console.error('Error fetching user contact:', err);
                setError('Failed to load your profile information. Please try again.');
                setIsLoading(false);
            }
        };

        fetchContact();
    }, []);

    // Set up react-hook-form
    const form = useForm<ProfileFormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            firstName: "",
            lastName: "",
        },
    });

    // Update form values when contact data is loaded
    useEffect(() => {
        if (contact) {
            form.reset({
                firstName: contact.firstName || "",
                lastName: contact.lastName || "",
            });
        }
    }, [contact, form]);

    const navigate = useNavigate();

    // Handle form submission
    const handleSubmit = form.handleSubmit(async (data) => {
        if (!contact) return;

        try {
            setIsLoading(true);

            // Create a proper contact update object
            const updateData = {
                ...contact,
                firstName: data.firstName,
                lastName: data.lastName || "", // Ensure lastName is never undefined
                avatar: avatar || "" // Ensure avatar is never undefined
            };

            // Update the contact
            await updateContactMutation.mutateAsync(updateData);

            setError(null);
            setIsLoading(false);

            toast.success('Profile updated successfully');

            // redirect to profile page
            navigate({to: '/'});
        } catch (err) {
            console.error('Error updating profile:', err);
            setError('Failed to update your profile. Please try again.');
            setIsLoading(false);
        }
    });

    if (isLoading && !contact) {
        return <div className="flex justify-center items-center h-64">Loading your profile...</div>;
    }

    if (error && !contact) {
        return (
            <div className="flex justify-center items-center h-64 text-red-500">
                {error}
            </div>
        );
    }

    return (<>
            {error && (
                <div className="mb-4 p-3 bg-red-100 border border-red-200 text-red-600 rounded-md">
                    {error}
                </div>
            )}

            <Form {...form}>
                <form onSubmit={handleSubmit} className="space-y-8">
                    {/* Avatar Section */}
                    <div className="flex justify-center mb-8">
                        <div className="h-32 w-32 relative group">
                            <UserAvatar
                                name={contact ? `${contact.firstName} ${contact.lastName}` : ""}
                                email={contact?.email?.[0]}
                                imageUrl={avatar ?? undefined}
                                forceUseImageUrl={true}
                                className="h-full w-full"
                                size="lg"
                            />

                            {/* Hidden file input element */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        // Upload the file using the API and track progress
                                        const formData = new FormData();
                                        formData.append('file', file);

                                        // Create upload tracking object with the methods returned by createUpload
                                        const uploadHandler = upload.createUpload(file.name);

                                        try {
                                            // Use the uploadWithProgress helper with authentication
                                            const response = await uploadWithProgress({
                                                url: `${import.meta.env.VITE_API_HOST}/contacts/avatar`,
                                                formData,
                                                headers: {
                                                    'credentials': 'include'
                                                },
                                                onProgress: (progress: number) => {
                                                    // Update the progress in the UI
                                                    uploadHandler.updateProgress(progress);
                                                },
                                                onSuccess: (response: string) => {
                                                    uploadHandler.complete();
                                                    setAvatar(response);
                                                },
                                                onError: (err) => {
                                                    // Mark upload as failed
                                                    uploadHandler.error();
                                                    console.error('Upload error:', err);
                                                }
                                            });

                                            // Parse the response and update the avatar
                                            if (response.ok) {
                                                const responseData = await response.text();
                                                setAvatar(responseData);
                                            }
                                        } catch (err: unknown) {
                                            console.error('Error uploading file:', err);
                                            uploadHandler.error();
                                        }

                                        // Clean up the file input value so the same file can be selected again if needed
                                        e.target.value = '';
                                    }
                                }}
                            />

                            {/* Camera icon with dropdown */}
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
                                        // Trigger file input click when menu item is selected
                                        fileInputRef.current?.click();
                                    }}>
                                        Upload from files
                                    </DropdownMenuItem>
                                    {avatar && (
                                        <DropdownMenuItem onSelect={() => {
                                            // Remove avatar
                                            setAvatar(null);
                                        }}>
                                            Remove avatar
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>

                    {/* Name Fields */}
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                        {/* First Name */}
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

                        {/* Last Name */}
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
                    <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-md p-4">
                        <div className="flex">
                            <InfoIcon className="h-5 w-5 text-blue-500 mr-2"/>
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
                    {/* Save Button */}
                    <div className="flex justify-end">
                        <Button type="submit" disabled={isLoading} className="w-full sm:w-auto">
                            {isLoading ? "Saving..." : "Save Changes"}
                        </Button>
                    </div>
                </form>
            </Form>
        </>
    );
}
