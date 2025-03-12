import {Link} from "@tanstack/react-router";
import {cn} from "@workspace/ui/lib/utils";

interface AppLogoProps {
    appName?: string;
    className?: string;
}

export function AppLogo({appName = "Mail", className}: AppLogoProps) {
    return (
        <Link
            className={cn("text-xl flex items-center cursor-pointer", className)}
            to="/"
        >
            <span className="text-white font-bold">
                eigen
            </span>
            <span className="text-white">
                |{appName.toLowerCase()}&gt;
            </span>
        </Link>
    );
}
