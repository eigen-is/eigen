import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {useEffect} from 'react'
import {useAuth} from '@workspace/lib/auth/auth-context'

export const Route = createFileRoute('/login')({
    component: LoginPage,
})

function LoginPage() {
    const {isAuthenticated} = useAuth()
    const navigate = useNavigate()

    useEffect(() => {
        if (isAuthenticated) {
            navigate({to: '/'})
        }
    }, [isAuthenticated, navigate])

    return (
        <div className="min-h-screen flex items-center justify-center bg-background">
            <div className="max-w-md w-full space-y-8 p-8">
                <div className="text-center">
                    <h2 className="text-3xl font-extrabold">Admin Login</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Authentication required
                    </p>
                </div>
            </div>
        </div>
    )
}
