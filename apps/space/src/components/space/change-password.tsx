// The form that changes the user's password, on PageForm: the current one, the new one with a strength meter, and the
// choice to sign out other sessions. Space's password page shows it. useChangePassword sends the change, and a done
// change returns to Space's start page.

import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useChangePassword } from '@workspace/lib/auth';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH, validatePasswordStrength } from '@workspace/lib/validation';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { PageForm } from '@workspace/ui/components/layout/app';
import { Progress } from '@workspace/ui/components/progress';
import { InfoIcon } from 'lucide-react';
import { useForm, useFormState } from 'react-hook-form';
import { z } from 'zod';

const formSchema = z
    .object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z.string().min(MIN_PASSWORD_LENGTH, FIELD_MESSAGES.passwordTooShort),
        confirmPassword: z.string().min(MIN_PASSWORD_LENGTH, FIELD_MESSAGES.passwordTooShort),
        revokeOtherSessions: z.boolean(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
        message: FIELD_MESSAGES.passwordsDiffer,
        path: ['confirmPassword'],
    });

export function ChangePassword() {
    const navigate = useNavigate();
    const changePassword = useChangePassword();

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            currentPassword: '',
            newPassword: '',
            confirmPassword: '',
            revokeOtherSessions: true,
        },
    });

    // A hook's state, which the React Compiler reads afresh, where formState is mutated in place.
    const { isDirty } = useFormState({ control: form.control });

    const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword, revokeOtherSessions }) => {
        await changePassword.mutateAsync({ currentPassword, newPassword, revokeOtherSessions });
        await navigate({ to: '/', ignoreBlocker: true });
    });

    return (
        <Form {...form}>
            <PageForm changed={isDirty} onSubmit={onSubmit} submitLabel="Change password">
                <FormField
                    control={form.control}
                    name="currentPassword"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Current password</FormLabel>
                            <FormControl>
                                <Input
                                    type="password"
                                    placeholder="Enter current password"
                                    autoComplete="current-password"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="newPassword"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>New password</FormLabel>
                            <FormControl>
                                <Input
                                    type="password"
                                    placeholder="Enter new password"
                                    autoComplete="new-password"
                                    {...field}
                                />
                            </FormControl>
                            {field.value.length > 0 && (
                                <PasswordStrength strength={validatePasswordStrength(field.value)} />
                            )}
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Confirm new password</FormLabel>
                            <FormControl>
                                <Input
                                    autoComplete="new-password"
                                    type="password"
                                    placeholder="Confirm new password"
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="revokeOtherSessions"
                    render={({ field }) => (
                        <FormItem className="flex items-center">
                            <FormControl>
                                <Checkbox
                                    id="revokeOtherSessions"
                                    checked={field.value}
                                    onCheckedChange={field.onChange}
                                />
                            </FormControl>
                            <Label htmlFor="revokeOtherSessions" className="cursor-pointer">
                                Log out of all other devices
                            </Label>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <InfoIcon className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>Choose a strong password and don't reuse it for other accounts.</p>
                </div>
            </PageForm>
        </Form>
    );
}

// The meter under the new password, for a strength between 0 and 1.
function PasswordStrength({ strength }: { strength: number }) {
    const [label, color] = strength < 0.4 ? STRENGTHS[0] : strength < 0.7 ? STRENGTHS[1] : STRENGTHS[2];
    return (
        <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Password strength:</span>
                <span className="text-xs font-medium">{label}</span>
            </div>
            <Progress value={strength * 100} className="h-1.5" indicatorClassName={color} />
        </div>
    );
}

const STRENGTHS = [
    ['Weak', 'bg-destructive'],
    ['Good', 'bg-chart-4'],
    ['Strong', 'bg-chart-2'],
] as const;
