import {useEffect, useRef, useState} from "react";
import {Link} from "@tanstack/react-router";
import {cn} from "@workspace/ui/lib/utils";
import {apps} from "@workspace/lib/apps.ts";
import {useIsMobile} from "@workspace/ui/hooks/use-mobile";

interface AppLogoProps {
    appName?: string;
    className?: string;
    linkable?: boolean;
}

export function AppLogo({appName = "Mail", className, linkable = true}: AppLogoProps) {
    const [expanded, setExpanded] = useState(false);
    const logoRef = useRef<HTMLDivElement>(null);
    const isMobile = useIsMobile();

    // Handle clicks outside the logo to collapse it
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (logoRef.current && !logoRef.current.contains(event.target as Node)) {
                setExpanded(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    const handleLogoClick = () => {
        if (linkable) {
            setExpanded(!expanded);
        }
    };

    const LogoContent = () => (
        <>
            {expanded ? (<>
                    <span className="text-white font-bold pr-0.25">
                        eigen
                    </span>
                <div className="flex items-center animate-in slide-in-from-left-5 duration-300">
                    {apps.map((app) => (
                        <div key={app.name} className="flex items-center">
                            <span className="text-white p-0.5">
                                <a
                                    href={app.href}
                                    onClick={(e) => e.stopPropagation()}
                                    className={"hover:underline hover:opacity-75 transition-opacity duration-150 " + (appName.toLowerCase() === app.name.toLowerCase() ? ' underline' : '')}
                                >{app.name.toLowerCase()}
                            </a>
                            </span>
                            {app !== apps[apps.length - 1] && <span className="text-white p-0.5">|</span>}
                        </div>
                    ))}
                    <span className="text-white">&gt;</span>
                </div>
            </>) : (<>
                <span className="text-white font-bold">
                    eigen
                </span>
                <span className="text-white">
                    <span className="p-0.5">|</span>
                    {appName.toLowerCase()}
                    &gt;
                </span>
            </>)}
        </>
    );

    return (
        <div
            ref={logoRef}
            className={cn("text-xl flex items-center cursor-pointer select-none -mt-1", className)}
            onClick={handleLogoClick}
        >
            {linkable && !isMobile ? (
                <LogoContent/>
            ) : (
                <Link
                    className="flex items-center"
                    to="/"
                >
                    <span className="text-white font-bold">
                        eigen
                    </span>
                    <span className="text-white">
                        <span className="p-0.5">|</span>
                        {appName.toLowerCase()}
                        &gt;
                    </span>
                </Link>
            )}
        </div>
    );
}
