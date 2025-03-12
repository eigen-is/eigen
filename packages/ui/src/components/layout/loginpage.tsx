import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {useRouter} from "@tanstack/react-router";
import {useState} from "react";
import {Input} from "../ui/input.tsx";
import {Button} from "../ui/button.tsx";


export function LoginPage() {
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
            <div className="w-full max-w-md p-8 space-y-8 bg-white rounded-lg shadow-md">
                <div className="text-center">
                    <h1 className="text-2xl font-bold text-red-600">eigen<span className="font-normal">|mail&gt;</span>
                    </h1>
                    <p className="mt-2 text-gray-600">Enter your credentials to access your account</p>
                </div>

                {error && (
                    <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="mt-8 space-y-6">
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
                        {isLoading ? 'Signing in...' : 'Sign in'}
                    </Button>
                </form>
            </div>
        </div>
    );
}
