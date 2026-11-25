// The form of the invite sign-up page: a name, a username at the server's mail domain, and a password typed twice.
// It checks them before it sends anything, with each problem under its field, then creates the account through the
// invite and reloads into the new session on Space's start page.

import { zodResolver } from '@hookform/resolvers/zod';
import { loadIntoSession, useInviteRegister } from '@workspace/lib/auth';
import { FIELD_MESSAGES, MIN_PASSWORD_LENGTH, validateUsername } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { FormShell } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const signupSchema = z
    .object({
        name: z.string().min(1, FIELD_MESSAGES.nameMissing),
        username: z.string().superRefine((username, context) => {
            const problem = validateUsername(username.toLowerCase());
            if (problem) context.addIssue({ code: 'custom', message: problem });
        }),
        password: z.string().min(MIN_PASSWORD_LENGTH, FIELD_MESSAGES.passwordTooShort),
        confirmPassword: z.string(),
    })
    .refine((values) => values.password === values.confirmPassword, {
        message: FIELD_MESSAGES.passwordsDiffer,
        path: ['confirmPassword'],
    });

export function SignupForm({ token, mailDomain }: { token: string; mailDomain?: string }) {
    const register = useInviteRegister(token);
    const { pending, run } = useDialogPending();
    const form = useForm<z.infer<typeof signupSchema>>({
        resolver: zodResolver(signupSchema),
        defaultValues: { name: '', username: '', password: '', confirmPassword: '' },
    });

    const onSubmit = form.handleSubmit(async ({ name, username, password }) => {
        await register.mutateAsync({ name, username: username.toLowerCase(), password });
        await loadIntoSession('/');
    });

    return (
        <Form {...form}>
            <FormShell autoFocus className="space-y-6" onSubmit={() => run(onSubmit)}>
                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl>
                                <Input {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="username"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Username</FormLabel>
                            <InputGroup>
                                <FormControl>
                                    <InputGroupInput {...field} />
                                </FormControl>
                                <InputGroupAddon align="inline-end">
                                    <InputGroupText>@{mailDomain}</InputGroupText>
                                </InputGroupAddon>
                            </InputGroup>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                                <Input type="password" autoComplete="new-password" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Confirm password</FormLabel>
                            <FormControl>
                                <Input type="password" autoComplete="new-password" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <Button type="submit" className="w-full" pending={pending}>
                    Create account
                </Button>
            </FormShell>
        </Form>
    );
}
