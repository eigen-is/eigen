"use client"

import { cn } from "@/lib/utils";
import { useClientRouter } from "@/app/client-provider";

interface AppLogoProps {
  appName?: string;
  className?: string;
}

export function AppLogo({ appName = "Mail", className }: AppLogoProps) {
  const { navigate } = useClientRouter();
  
  return (
    <div 
      className={cn("font-semibold text-xl flex items-center cursor-pointer", className)}
      onClick={() => navigate('/')}
    >
      <span 
        className="bg-clip-text text-transparent bg-gradient-to-r from-purple-500 to-blue-500"
      >
        Eigen
      </span>
      <span className="text-foreground">{appName}</span>
    </div>
  );
}
