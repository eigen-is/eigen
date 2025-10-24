import {useState} from 'react'
import {createAdminUser} from '@workspace/lib/admin'
import {Button} from '@workspace/ui/components/button'
import {Input} from '@workspace/ui/components/input'
import {Label} from '@workspace/ui/components/label'

interface AdminUserFormProps {
    onSuccess: () => void
    onError: (error: string) => void
}

export function AdminUserForm({onSuccess, onError}: AdminUserFormProps) {
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        setLoading(true)
        onError('')

        const formData = new FormData(e.currentTarget)
        const usernameInput = formData.get('username') as string
        const data = {
            username: `${usernameInput}@eigen.is`,
            password: formData.get('password') as string,
            name: formData.get('name') as string,
        }

        try {
            const result = await createAdminUser(data)
            if (result?.success) {
                onSuccess()
            } else {
                onError(result?.error || 'Failed to create admin user')
            }
        } catch (err: any) {
            onError(err?.message || 'Network error. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
                <div>
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                        id="name"
                        name="name"
                        type="text"
                        required
                        className="mt-1.5"
                    />
                </div>

                <div>
                    <Label htmlFor="username">Username</Label>
                    <div className="mt-1.5 flex">
                        <Input
                            id="username"
                            name="username"
                            type="text"
                            required
                            placeholder="admin"
                            className="rounded-r-none"
                        />
                        <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-input bg-muted text-muted-foreground text-sm">
                            @eigen.is
                        </span>
                    </div>
                </div>

                <div>
                    <Label htmlFor="password">Password</Label>
                    <Input
                        id="password"
                        name="password"
                        type="password"
                        required
                        minLength={8}
                        className="mt-1.5"
                    />
                    <p className="text-xs text-muted-foreground mt-1.5">Must be at least 8 characters</p>
                </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Creating...' : 'Create Admin User'}
            </Button>
        </form>
    )
}
