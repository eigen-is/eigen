import {cn} from '../../lib/utils';
import {useEffect, useState} from 'react';
import {Bra} from "./bra.tsx";
import {Ket} from "./ket.tsx";

type EigenLoadingScreenProps = {
    className?: string;
};

const animationStyles = {
    moveLeftChevron: `
    @keyframes moveLeftChevron {
      0%, 100% { transform: translateX(-6px); }
      50% { transform: translateX(-12px); }
    }
  `,
    moveRightChevron: `
    @keyframes moveRightChevron {
      0%, 100% { transform: translateX(6px); }
      50% { transform: translateX(12px); }
    }
  `
};

export function EigenLoader({className}: EigenLoadingScreenProps) {
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

            <div className={cn("relative text-muted-foreground",
                className
            )}>
                {/* Left Chevron */}
                <Bra
                    className="h-4 w-4 absolute"
                    style={{
                        left: '-10px',
                        animation: animationStarted ? 'moveLeftChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                />

                {/* Right Chevron */}
                <Ket
                    className="h-4 w-4 absolute"
                    style={{
                        left: '10px',
                        animation: animationStarted ? 'moveRightChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                />
            </div>
        </>
    );
}
