import {cn} from '../../lib/utils';
import {useEffect, useState} from 'react';
import {Bra} from "./bra.tsx";
import {Ket} from "./ket.tsx";

type EigenLoadingScreenProps = {
    className?: string;
    children?: React.ReactNode;
};

const animationStyles = {
    moveLeftChevron: `
    @keyframes moveLeftChevron {
      0%, 100% { transform: translateX(0px); }
      50% { transform: translateX(-6px); }
    }
  `,
    moveRightChevron: `
    @keyframes moveRightChevron {
      0%, 100% { transform: translateX(0px); }
      50% { transform: translateX(6px); }
    }
  `
};

export function EigenLoader({className, children}: EigenLoadingScreenProps) {
    const [animationStarted, setAnimationStarted] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setAnimationStarted(true);
        }, 300);

        return () => clearTimeout(timer);
    }, []);

    return (
        <>
            <style>
                {animationStyles.moveLeftChevron}
                {animationStyles.moveRightChevron}
            </style>

            <div className={cn("text-muted-foreground",
                className
            )}>
                {/* Left Chevron */}
                <Bra
                    style={{
                        animation: animationStarted ? 'moveLeftChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                />
                {/* Optional Text */}
                {children && (
                    <span className="px-2">{children}</span>
                )}
                {/* Right Chevron */}
                <Ket
                    style={{
                        animation: animationStarted ? 'moveRightChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                />
            </div>
        </>
    );
}
