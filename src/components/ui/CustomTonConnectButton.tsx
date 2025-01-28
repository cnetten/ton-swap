import React, { useEffect, useState } from "react";
import { Wallet, Copy, LogOut, MoreVertical } from "lucide-react";
import { useTonConnectUI } from "../tonconnect/hooks/useTonConnectUI";
import { useTonAddress } from "../tonconnect/hooks/useTonAddress";
import { Button } from "./button";

interface CustomTonConnectButtonProps {
  variant?: "default" | "outline" | "minimal";
  size?: "sm" | "md" | "lg";
}

const CustomTonConnectButton: React.FC<CustomTonConnectButtonProps> = ({
  variant = "default",
  size = "md",
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [tonConnectUI] = useTonConnectUI();
  const userFriendlyAddress = useTonAddress();

  const copyAddress = () => {
    navigator.clipboard.writeText(userFriendlyAddress);
    setShowDropdown(false);
  };

  return (
    <div className="relative flex items-center justify-between w-full gap-2">
      <button
        onClick={() =>
          !tonConnectUI.connected ? tonConnectUI.openModal() : null
        }
        className="rounded-lg flex items-center gap-2 transition-all duration-200 font-medium"
      >
        <Wallet className="w-5 h-5" />
        {tonConnectUI.connected ? (
          <div className="flex flex-col items-start">
            <span className="text-sm">
              {tonConnectUI.connected || "Connected"}
            </span>
            <span className="text-xs opacity-75">
              {userFriendlyAddress.slice(0, 6)}...
              {userFriendlyAddress.slice(-4)}
            </span>
          </div>
        ) : (
          "Connect Wallet"
        )}
      </button>

      {tonConnectUI.connected && (
        <>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="p-1 rounded-full transition-colors ml-auto"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {showDropdown && (
            <div className="p-2 wallet-dropdown bg-background absolute right-0 bottom-full mb-2 w-48 rounded-lg shadow-lg border py-1 z-50">
              <Button
                onClick={copyAddress}
                className="w-full px-4 py-2 mb-2.5 transition-colors bg-transparent text-muted-foreground hover:bg-secondary/50 text-left flex items-center gap-2 shadow-none"
              >
                <Copy className="w-4 h-4" />
                <span>Copy Address</span>
              </Button>
              <Button
                onClick={() => {
                  tonConnectUI.disconnect();
                  setShowDropdown(false);
                }}
                className="w-full px-4 py-2 transition-colors bg-transparent text-muted-foreground hover:bg-secondary/50 text-left flex items-center gap-2 text-red-500 shadow-none"
              >
                <LogOut className="w-4 h-4" />
                <span>Disconnect</span>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CustomTonConnectButton;
