import { useState } from 'react'
import { createAdminUser } from '@workspace/lib/admin'

interface AdminUserFormProps {
  onSuccess: () => void
  onError: (error: string) => void
}

export function AdminUserForm({ onSuccess, onError }: AdminUserFormProps) {
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
    <form onSubmit={handleSubmit} className="mt-8 space-y-6">
      <div className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Full Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label htmlFor="username" className="block text-sm font-medium text-gray-700">
            Username
          </label>
          <div className="mt-1 flex rounded-md shadow-sm">
            <input
              id="username"
              name="username"
              type="text"
              required
              className="flex-1 block w-full px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              placeholder="admin"
            />
            <span className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500 text-sm">
              @eigen.is
            </span>
          </div>
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">Must be at least 8 characters long</p>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Creating...' : 'Create Admin User'}
      </button>
    </form>
  )
}
