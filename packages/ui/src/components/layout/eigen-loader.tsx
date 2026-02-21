import {cn} from '../../lib/utils';
import {useEffect, useState} from 'react';

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
                <svg
                    className="h-8 w-8 absolute"
                    style={{
                        left: '-10px',
                        animation: animationStarted ? 'moveLeftChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m9 7-5 5 5 5"/>
                </svg>

                {/* Right Chevron */}
                <svg
                    className="h-8 w-8 absolute"
                    style={{
                        right: '-10px',
                        animation: animationStarted ? 'moveRightChevron 1.5s infinite ease-in-out' : 'none'
                    }}
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m15 7 5 5-5 5"/>
                </svg>
            </div>
        </>
    );
}
