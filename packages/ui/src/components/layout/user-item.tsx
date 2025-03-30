"use client"

import * as React from "react"
import { cn } from "@workspace/ui/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@workspace/ui/components/avatar"

export interface UserItemProps extends React.HTMLAttributes<HTMLDivElement> {
  name?: string
  email?: string
  imageUrl?: string
  userId?: string
  label?: React.ReactNode
  className?: string
}

export function UserItem({
  name,
  email,
  imageUrl,
  userId,
  label,
  className,
  ...props
}: UserItemProps) {
  const displayName = name || email || ""
  const firstChar = displayName.charAt(0).toUpperCase()

  return (
    <div className={cn("flex items-center", className)} {...props}>
      {/* Profile image/avatar placeholder */}
      <Avatar className="h-8 w-8">
        {imageUrl && <AvatarImage src={imageUrl} alt={displayName} />}
        <AvatarFallback className="bg-gray-200 text-gray-600 font-medium">
          {firstChar}
        </AvatarFallback>
      </Avatar>

      <div className="ml-3 flex-1">
        <p className="text-sm font-medium text-gray-900">{displayName}</p>
        <div className="flex justify-between items-center">
          {email && name && <p className="text-xs text-gray-500">{email}</p>}
          {label && (
            <p className="text-xs text-gray-500 whitespace-nowrap ml-auto">
              {label}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
