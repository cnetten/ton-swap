/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { useTheme } from "next-themes";

interface MultiRouteInfoProps {
  isMultiRoute: boolean;
  swapPaths: any[];
  multiRouteInfo?: {
    pathReadable: string;
    percentages: number[];
    totalOutput: string;
  };
}

const MultiRouteInfo: React.FC<MultiRouteInfoProps> = ({
  isMultiRoute,
  swapPaths,
  multiRouteInfo,
}) => {
  const { theme } = useTheme();

  // If not a multi-route, don't show anything
  if (!isMultiRoute || !multiRouteInfo) {
    return null;
  }

  return (
    <div
      className={`p-3 rounded-lg space-y-1 mt-2 ${
        theme === "dark" ? "bg-zinc-900" : "bg-gray-50"
      }`}
    >
      <div className="flex justify-between text-sm">
        <span className={theme === "dark" ? "text-gray-400" : "text-gray-500"}>
          Multi-Route Split
        </span>
        <span className={theme === "dark" ? "text-gray-300" : "text-gray-700"}>
          {multiRouteInfo.pathReadable}
        </span>
      </div>

      {swapPaths.map((path, index) => (
        <div key={index} className="flex justify-between text-sm">
          <span
            className={theme === "dark" ? "text-gray-400" : "text-gray-500"}
          >
            {path.source} ({path.percentage}%)
          </span>
          <span
            className={theme === "dark" ? "text-gray-300" : "text-gray-700"}
          >
            {path.pathReadable}
          </span>
        </div>
      ))}
    </div>
  );
};

export default MultiRouteInfo;
