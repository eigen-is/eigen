"use client"

import { HTMLAttributes } from "react"
import { cn } from "@workspace/ui/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@workspace/ui/components/avatar"
import { spaceApi } from "@workspace/lib/api"
import { useQuery } from "@tanstack/react-query"

export interface UserAvatarProps extends HTMLAttributes<HTMLDivElement> {
  name?: string
  email?: string
  imageUrl?: string
  userId?: string
  className?: string
  size?: "sm" | "md" | "lg"
}

// Query keys for public user data
const publicUserKeys = {
  all: ['publicUser'] as const,
  details: () => [...publicUserKeys.all, 'detail'] as const,
  detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

// Hook to fetch public user data
export function usePublicUser(id: string | undefined) {
  return useQuery({
    queryKey: publicUserKeys.detail(id || ''),
    queryFn: async () => {
      if (!id) return null;
      const res = await spaceApi.public[id].get();
      return res.data;
    },
    enabled: !!id,
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
  });
}

export function UserAvatar({
  name,
  email,
  imageUrl,
  userId,
  className,
  size = "md",
  ...props
}: UserAvatarProps) {
  const displayName = name || email || "";
  const firstChar = displayName.charAt(0).toUpperCase();
  
  // Use the ID for lookup (prefer userId if available, fall back to email)
  const lookupId = userId || email;
  
  // Fetch public user data if we don't have an image URL
  const { data: publicUserData } = usePublicUser(
    imageUrl ? undefined : lookupId
  );
  
  // Determine the image to display
  const avatarImage = imageUrl || publicUserData?.image || "";

  // Size classes
  const sizeClasses = {
    sm: "h-6 w-6",
    md: "h-8 w-8",
    lg: "h-10 w-10"
  };

  return (
    <Avatar className={cn(sizeClasses[size], className)} {...props}>
      {avatarImage && <AvatarImage src={avatarImage} alt={displayName} />}
      <AvatarFallback className="bg-gray-200 text-gray-600 font-medium">
        {firstChar}
      </AvatarFallback>
    </Avatar>
  );
}
