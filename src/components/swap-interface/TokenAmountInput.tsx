import { Token } from "@/types/token";
import { Wallet } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Button } from "../ui/button";
import Image from "next/image";
import TokenSelector from "./TokenSelector";
import { calculatePrice } from "./utils/calculations";

interface TokenAmountInputProps {
  token: Token;
  amount: string;
  balance?: string;
  onChange: (amount: string) => void;
  onSelectToken: (token: Token) => void;
  readonly?: boolean;
  fromTokenPrice?: string;
  fromAmount?: string;
  label: string;
  currentTokenAddress?: string;
  walletAddress?: string;
}

const TokenAmountInput: React.FC<TokenAmountInputProps> = ({
  token,
  amount,
  balance,
  onChange,
  onSelectToken,
  readonly = false,
  label,
  fromTokenPrice,
  fromAmount,
  currentTokenAddress,
  walletAddress,
}) => {
  const { theme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [tokenPrice, setTokenPrice] = useState<string | number | null>();

  useEffect(() => {
    const tokenPrice = calculatePrice(token, label, amount);
    setTokenPrice(tokenPrice);
  }, [amount, fromAmount, fromTokenPrice, label, token]);

  return (
    <div
      className={`p-4 rounded-lg ${
        theme === "dark" ? "bg-zinc-900" : "bg-gray-50"
      }`}
    >
      <div className="flex justify-between mb-2">
        <span
          className={`text-xl ${
            theme === "dark" ? "text-gray-300" : "text-gray-500"
          }`}
        >
          {label}
        </span>

        <span
          className={`text-sm flex justify-center items-center ${
            theme === "dark" ? "text-gray-300" : "text-gray-500"
          }`}
        >
          <Wallet size={15} className="mr-1" /> {balance ? balance : 0}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={amount}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.0"
          className="pl-0 text-xl border-none bg-transparent shadow-none w-full no-focus no-focus-visible"
          readOnly={readonly}
        />
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              className={`min-w-[120px] ${
                theme === "dark" ? "bg-zinc-800" : ""
              }`}
            >
              {token ? (
                <div className="flex items-center gap-2">
                  <Image
                    src={token?.meta?.imageUrl ? token?.meta?.imageUrl : ""}
                    alt={token?.meta?.symbol ? token?.meta?.symbol : ""}
                    width={20}
                    height={20}
                    className="rounded-full"
                  />
                  <span>{token?.meta?.symbol}</span>
                </div>
              ) : (
                "Select Token"
              )}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogTitle>Select a token</DialogTitle>
            <TokenSelector
              onSelect={(selectedToken) => {
                onSelectToken(selectedToken);
                setIsOpen(false);
              }}
              walletAddress={walletAddress}
              currentTokenAddress={currentTokenAddress}
            />
          </DialogContent>
        </Dialog>
      </div>
      {token?.dexPriceUsd && (
        <div
          className={`text-sm mt-2 ${
            theme === "dark" ? "text-gray-400" : "text-gray-500"
          }`}
        >
          ${tokenPrice}
        </div>
      )}
    </div>
  );
};

export default TokenAmountInput;
