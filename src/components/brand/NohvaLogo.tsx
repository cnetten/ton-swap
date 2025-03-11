"use client";
import React from "react";
import { useTheme } from "next-themes";

export const NohvaLogo = ({ className = "" }) => {
  const { theme } = useTheme();

  return (
    <div className={`select-none ${className}`}>
      <h1
        className={`text-4xl font-extrabold tracking-wide 
        ${
          theme === "dark"
            ? "text-white outline-text-white"
            : "text-black outline-text-black"
        }
        inline-block`}
      >
        NOHVA
        {/* <span className="text-xs align-super ml-0.5 font-bold text-gray-600 dark:text-gray-400">
          ™
        </span> */}
      </h1>
    </div>
  );
};

// Add global styles for text outlines
export const LogoStyles = () => (
  <style jsx global>{`
    .outline-text-black {
      text-shadow: -1px -1px 0 black, 1px -1px 0 black, -1px 1px 0 black,
        1px 1px 0 black;
    }
    .outline-text-white {
      text-shadow: -1px -1px 0 white, 1px -1px 0 white, -1px 1px 0 white,
        1px 1px 0 white;
    }
  `}</style>
);

export default NohvaLogo;
