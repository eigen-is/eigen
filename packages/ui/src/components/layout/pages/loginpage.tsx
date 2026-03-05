import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {useRouter} from "@tanstack/react-router";
import {useEffect, useState} from "react";
import {zodResolver} from "@hookform/resolvers/zod";
import {useForm} from "react-hook-form";
import {z} from "zod";
import {Button} from "../../button.tsx";
import {Card, CardContent, CardDescription, CardHeader, CardTitle,} from "../../card.tsx";
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage,} from "../../form.tsx";
import {InputGroup, InputGroupAddon, InputGroupInput, InputGroupText} from "../../input-group.tsx";
import {Input} from "../../input.tsx";
import {usePublicConfig} from "@workspace/lib/public";
import {useApp} from "../app/layout-context.tsx";
import {Bar} from "../braket/bar.tsx";
import {Ket} from "../braket/ket.tsx";

// Define the login form schema with Zod
const loginFormSchema = z.object({
    email: z.string().min(1, {message: "Username is required"}),
    password: z.string().min(1, {message: "Password is required"}),
});

// Type for the form values
type LoginFormValues = z.infer<typeof loginFormSchema>;

export function LoginPage() {
    const {login, isAuthenticated} = useAuth();
    const router = useRouter();
    const {appName} = useApp();
    const {data: config} = usePublicConfig();
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

        values.email = values.email.toLowerCase().split('@')[0] + '@' + (config?.domain ?? 'eigen.is');

        try {
            const {success, error} = await login(values.email, values.password);

            if (!success && error) {
                const errorMessage = error instanceof Error ? error.message : 'Login failed';
                setError(errorMessage);
            }
        } catch (err) {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isAuthenticated) {
            router.invalidate();
        }
    }, [isAuthenticated, router]);

    return (
        <div className="flex w-full h-[calc(100vh-64px)] items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl text-app">
                        <span className="font-bold">eigen</span>
                        <span className="font-normal"><Bar/>{appName}<Ket/></span>
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
                                render={({field}) => (
                                    <FormItem>
                                        <FormLabel>Username</FormLabel>
                                        <FormControl>
                                            <InputGroup>
                                                <InputGroupInput placeholder="username" autoFocus {...field} />
                                                <InputGroupAddon align="inline-end">
                                                    <InputGroupText>@{config?.domain ?? 'eigen.is'}</InputGroupText>
                                                </InputGroupAddon>
                                            </InputGroup>
                                        </FormControl>
                                        <FormMessage/>
                                    </FormItem>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="password"
                                render={({field}) => (
                                    <FormItem>
                                        <FormLabel>Password</FormLabel>
                                        <FormControl>
                                            <Input type="password" {...field} />
                                        </FormControl>
                                        <FormMessage/>
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
