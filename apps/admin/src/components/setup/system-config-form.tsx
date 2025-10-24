import { useState } from 'react'
import { configureSystem } from '@workspace/lib/admin'

interface SystemConfigFormProps {
  onSuccess: () => void
  onError: (error: string) => void
}

export function SystemConfigForm({ onSuccess, onError }: SystemConfigFormProps) {
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setLoading(true)
    onError('')

    const formData = new FormData(e.currentTarget)
    const data = {
      domain: formData.get('domain') as string,
      smtpHost: formData.get('smtpHost') as string,
      smtpPort: parseInt(formData.get('smtpPort') as string),
      smtpUser: formData.get('smtpUser') as string,
      smtpPassword: formData.get('smtpPassword') as string,
      smtpFrom: formData.get('smtpFrom') as string,
    }

    try {
      const result = await configureSystem(data)
      
      if (result?.success) {
        onSuccess()
      } else {
        onError(result?.error || 'Failed to configure system')
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
          <label htmlFor="domain" className="block text-sm font-medium text-gray-700">
            Domain
          </label>
          <input
            id="domain"
            name="domain"
            type="text"
            required
            defaultValue="localhost:8000"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            placeholder="example.com"
          />
          <p className="mt-1 text-xs text-gray-500">Your domain without protocol</p>
        </div>

        <div>
          <label htmlFor="smtpHost" className="block text-sm font-medium text-gray-700">
            SMTP Host
          </label>
          <input
            id="smtpHost"
            name="smtpHost"
            type="text"
            required
            defaultValue="localhost"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label htmlFor="smtpPort" className="block text-sm font-medium text-gray-700">
            SMTP Port
          </label>
          <input
            id="smtpPort"
            name="smtpPort"
            type="number"
            required
            defaultValue="1025"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label htmlFor="smtpUser" className="block text-sm font-medium text-gray-700">
            SMTP Username (optional)
          </label>
          <input
            id="smtpUser"
            name="smtpUser"
            type="text"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label htmlFor="smtpPassword" className="block text-sm font-medium text-gray-700">
            SMTP Password (optional)
          </label>
          <input
            id="smtpPassword"
            name="smtpPassword"
            type="password"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div>
          <label htmlFor="smtpFrom" className="block text-sm font-medium text-gray-700">
            From Email (optional)
          </label>
          <input
            id="smtpFrom"
            name="smtpFrom"
            type="email"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            placeholder="noreply@example.com"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Configuring...' : 'Continue to User Setup'}
      </button>
    </form>
  )
}
