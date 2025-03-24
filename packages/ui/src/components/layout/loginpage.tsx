import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {useRouter} from "@tanstack/react-router";
import {useState} from "react";
import {zodResolver} from "@hookform/resolvers/zod";
import {useForm} from "react-hook-form";
import {z} from "zod";
import {Input} from "../input.tsx";
import {Button} from "../button.tsx";
import {Card, CardContent, CardDescription, CardHeader, CardTitle,} from "../card.tsx";
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage,} from "../form.tsx";

// Define the login form schema with Zod
const loginFormSchema = z.object({
    email: z.string().email({ message: "Invalid email address" }),
    password: z.string().min(1, { message: "Password is required" }),
});

// Type for the form values
type LoginFormValues = z.infer<typeof loginFormSchema>;

export function LoginPage({ appName = 'mail' }: { appName?: string }) {
    const { login } = useAuth();
    const router = useRouter();
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // Initialize the form with react-hook-form and zod validator
    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginFormSchema),
        defaultValues: {
            email: "",
            password: "",
        },
    });

    // Form submission handler
    const onSubmit = async (values: LoginFormValues) => {
        setIsLoading(true);
        setError('');

        try {
            const { success, error } = await login(values.email, values.password);

            if (!success && error) {
                setError(error.message || 'Login failed');
                return;
            }

            // On success, TanStack Router will automatically navigate to the home page
            // due to the redirect in the root route's loader
        } catch (err) {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
            await router.invalidate();
        }
    };

    return (
        <div className="flex h-[calc(100vh-64px)] items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl">
                        <span className="font-bold text-app">eigen</span>
                        <span className="font-normal text-app">|{appName}&gt;</span>
                    </CardTitle>
                    <CardDescription>
                        Enter your credentials to access your account
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    {error && (
                        <div className="p-3 mb-4 text-sm text-red-500 bg-red-50 rounded-md">
                            {error}
                        </div>
                    )}

                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                            <FormField
                                control={form.control}
                                name="email"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>Email</FormLabel>
                                        <FormControl>
                                            <Input placeholder="your@eigen.is" autoFocus {...field} />
                                        </FormControl>
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
                                            <Input type="password" {...field} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <Button 
                                type="submit" 
                                className="w-full" 
                                disabled={isLoading}
                            >
                                {isLoading ? 'Signing in...' : 'Sign in'}
                            </Button>
                        </form>
                    </Form>
                </CardContent>
            </Card>
        </div>
    );
}
