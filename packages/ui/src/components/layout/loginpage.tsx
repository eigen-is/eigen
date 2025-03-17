import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {useRouter} from "@tanstack/react-router";
import {useState} from "react";
import {Input} from "../input.tsx";
import {Button} from "../button.tsx";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "../card.tsx";

export function LoginPage({ appName = 'mail' }: { appName?: string }) {
    const {login} = useAuth();
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError('');

        try {
            const {success, error} = await login(email, password);

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
                        Voer je gegevens in om toegang te krijgen tot je account
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    {error && (
                        <div className="p-3 mb-4 text-sm text-red-500 bg-red-50 rounded-md">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-4">
                            <div>
                                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                                    Email
                                </label>
                                <Input
                                    id="email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    className="mt-1"
                                    placeholder="your@email.com"
                                />
                            </div>

                            <div>
                                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                                    Password
                                </label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                    className="mt-1"
                                />
                            </div>
                        </div>

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={isLoading}
                        >
                            {isLoading ? 'Bezig met inloggen...' : 'Inloggen'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
