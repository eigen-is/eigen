import {useEffect, useRef, useState} from "react";
import {Link} from "@tanstack/react-router";
import {cn} from "../../../lib/utils.ts";
import {apps} from "@workspace/lib/apps.ts";
import {useIsMobile} from "../../../hooks/";
import {Ket} from "../braket/ket.tsx";
import {Bar} from "../braket/bar.tsx";

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
        <div className="flex">
                <span className="text-white font-bold ">
                    eigen
                </span>
            {expanded ? (<>
                <div className="flex animate-in slide-in-from-left-5 duration-300 text-white">
                    {apps.map((app) => (
                        <div key={app.name}>
                            <span><Bar/></span>
                            <span>
                                <a
                                    href={app.href}
                                    onClick={(e) => e.stopPropagation()}
                                    className={"hover:underline hover:opacity-75 transition-opacity duration-150 " + (appName.toLowerCase() === app.name.toLowerCase() ? ' underline' : '')}
                                >{app.name.toLowerCase()}
                            </a>
                            </span>
                        </div>
                    ))}
                    <span><Ket/></span>
                </div>
            </>) : (<>
                <span className="text-white">
                    <Bar/>
                    {appName.toLowerCase()}
                    <Ket/>
                </span>
            </>)}
        </div>
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
