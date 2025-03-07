"use client"

import { cn } from "@/lib/utils";

interface AppLogoProps {
  appName?: string;
  className?: string;
}

export function AppLogo({ appName = "Mail", className }: AppLogoProps) {
  return (
    <div className={cn("font-semibold text-xl flex items-center", className)}>
      <span 
        className="bg-clip-text text-transparent bg-gradient-to-r from-purple-500 to-blue-500"
      >
        Eigen
      </span>
      <span className="text-foreground">{appName}</span>
    </div>
  );
}
