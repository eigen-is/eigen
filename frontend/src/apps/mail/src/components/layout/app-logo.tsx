import {cn} from "@/lib/utils";
import {Link} from "@tanstack/react-router";

interface AppLogoProps {
    appName?: string;
    className?: string;
}

export function AppLogo({appName = "Mail", className}: AppLogoProps) {
    return (
        <Link
            className={cn("font-semibold text-xl flex items-center cursor-pointer", className)}
            to="/"
        >
      <span
          className="bg-clip-text text-transparent bg-gradient-to-r from-purple-500 to-blue-500"
      >
        Eigen
      </span>
            <span className="text-foreground">{appName}</span>
        </Link>
    );
}
