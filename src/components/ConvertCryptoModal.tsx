import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useCurrency } from "@/lib/currency-context";
import { useBinancePrices } from "@/hooks/useBinancePrices";
import { soundFX } from "@/lib/sound-engine";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Sparkles, DollarSign, ArrowRight, ShieldCheck } from "lucide-react";
import { CryptoIcon } from "@/components/CryptoIcon";

const SUPPORTED_CRYPTO = [
  { symbol: "USDT", name: "Tether USD", icon: "₮", decimals: 2 },
  { symbol: "BTC", name: "Bitcoin", icon: "₿", decimals: 6 },
  { symbol: "ETH", name: "Ethereum", icon: "Ξ", decimals: 5 },
  { symbol: "BNB", name: "BNB", icon: "B", decimals: 4 },
  { symbol: "SOL", name: "Solana", icon: "◎", decimals: 4 },
  { symbol: "XRP", name: "Ripple", icon: "✕", decimals: 2 },
  { symbol: "ADA", name: "Cardano", icon: "₳", decimals: 2 },
  { symbol: "DOGE", name: "Dogecoin", icon: "Ð", decimals: 2 },
];

const PRICE_SYMBOLS = SUPPORTED_CRYPTO.filter((s) => s.symbol !== "USDT").map(
  (s) => `${s.symbol}USDT`,
);

const FALLBACK_PRICES: Record<string, number> = {
  USDT: 1.0,
  BTC: 96500,
  ETH: 3450,
  BNB: 650,
  SOL: 195,
  XRP: 2.45,
  ADA: 0.85,
  DOGE: 0.28,
};

interface ConvertCryptoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSymbol?: string;
}

export function ConvertCryptoModal({
  open,
  onOpenChange,
  defaultSymbol = "ALL",
}: ConvertCryptoModalProps) {
  const { user } = useAuth();
  const { formatCurrency, currencyInfo } = useCurrency();
  const qc = useQueryClient();
  const { tickers } = useBinancePrices(PRICE_SYMBOLS);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(defaultSymbol);
  const [isConverting, setIsConverting] = useState(false);

  // Fetch crypto holdings
  const { data: wallets } = useQuery({
    queryKey: ["my_crypto_wallets", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from("user_crypto_balances")
        .select("*")
        .eq("user_id", user.id);
      return data ?? [];
    },
    enabled: !!user && open,
  });

  // Fetch profile for live_balance & json crypto_balances
  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("live_balance, crypto_balances")
        .eq("id", user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user && open,
  });

  // Calculate holdings with live prices
  const holdings = useMemo(() => {
    const jsonBalances = ((profile as { crypto_balances?: Record<string, number> })
      ?.crypto_balances ?? {}) as Record<string, number>;
    const rowMap = new Map<string, number>();
    (wallets ?? []).forEach((w: Record<string, unknown>) =>
      rowMap.set(
        String(w.asset_symbol || w.symbol || "").toUpperCase(),
        Number(w.balance ?? w.amount ?? 0),
      ),
    );

    return SUPPORTED_CRYPTO.map((meta) => {
      const qty = Math.max(rowMap.get(meta.symbol) ?? 0, Number(jsonBalances[meta.symbol] ?? 0));
      const livePrice = meta.symbol === "USDT" ? 1.0 : tickers[`${meta.symbol}USDT`]?.price;
      const price = livePrice && livePrice > 0 ? livePrice : (FALLBACK_PRICES[meta.symbol] ?? 1.0);
      return {
        ...meta,
        qty,
        price,
        usdValue: qty * price,
      };
    });
  }, [wallets, profile, tickers]);

  // Target conversion items based on dropdown selection
  const conversionItems = useMemo(() => {
    if (selectedSymbol === "ALL") {
      return holdings.filter((h) => h.qty > 0);
    }
    return holdings.filter((h) => h.symbol === selectedSymbol && h.qty > 0);
  }, [holdings, selectedSymbol]);

  const totalUsdToCredit = useMemo(() => {
    return conversionItems.reduce((acc, item) => acc + item.usdValue, 0);
  }, [conversionItems]);

  const handleConvert = async () => {
    if (!user) return;
    if (conversionItems.length === 0 || totalUsdToCredit <= 0) {
      toast.error("No active crypto holdings available to convert.");
      return;
    }

    setIsConverting(true);
    soundFX.playClick();
    soundFX.triggerHaptic(30);

    try {
      const currentLiveBalance = Number(profile?.live_balance ?? 0);
      const newLiveBalance = Number((currentLiveBalance + totalUsdToCredit).toFixed(2));

      const updatedJson = {
        ...(((profile as { crypto_balances?: Record<string, number> })?.crypto_balances ??
          {}) as Record<string, number>),
      };

      // Process each converting token
      for (const item of conversionItems) {
        // Zero out in user_crypto_balances table
        await supabase.from("user_crypto_balances").upsert(
          {
            user_id: user.id,
            asset_symbol: item.symbol,
            balance: 0,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,asset_symbol" },
        );

        // Zero out in JSON map
        updatedJson[item.symbol] = 0;
      }

      // 1. Update live balance & crypto_balances JSON in profile
      const { error: profErr } = await supabase
        .from("profiles")
        .update({
          live_balance: newLiveBalance,
          crypto_balances: updatedJson as any,
        })
        .eq("id", user.id);

      if (profErr) throw profErr;

      // 2. Record transaction log
      const desc =
        conversionItems.length === 1
          ? `Converted ${conversionItems[0].qty.toFixed(4)} ${conversionItems[0].symbol} to $${totalUsdToCredit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD Live Balance`
          : `Converted all crypto holdings (${conversionItems.map((c) => `${c.qty.toFixed(4)} ${c.symbol}`).join(", ")}) to $${totalUsdToCredit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD Live Balance`;

      await supabase.from("transactions").insert({
        user_id: user.id,
        type: "swap",
        amount: totalUsdToCredit,
        description: desc,
        status: "approved",
      });

      soundFX.playDepositBonus();
      soundFX.triggerHaptic(80);

      toast.success(
        `Converted crypto holdings to ${formatCurrency(totalUsdToCredit)} ${currencyInfo.code} Live Balance!`,
      );

      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["my_crypto_wallets"] });
      qc.invalidateQueries({ queryKey: ["user_profile_navbar"] });

      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? "Conversion failed. Please try again.");
    } finally {
      setIsConverting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-slate-950 border-emerald-500/30 text-slate-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-black text-white">
            <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin-slow" />
            Convert Crypto to USD Live Balance
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-300">
            Instantly liquidate your crypto wallet holdings into usable USD Live Balance with 0%
            conversion fees.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Asset Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Select Holding to Convert
            </Label>
            <Select value={selectedSymbol} onValueChange={setSelectedSymbol}>
              <SelectTrigger className="bg-slate-900 border-slate-800 text-white font-medium">
                <SelectValue placeholder="Select asset to convert" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-slate-800 text-white">
                <SelectItem value="ALL" className="font-bold text-emerald-400">
                  ✨ Convert ALL Crypto Holdings (
                  {formatCurrency(holdings.reduce((s, h) => s + h.usdValue, 0))})
                </SelectItem>
                {holdings.map((h) => (
                  <SelectItem key={h.symbol} value={h.symbol} disabled={h.qty <= 0}>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-amber-300">
                        {h.icon} {h.symbol}
                      </span>
                      <span className="text-xs text-slate-400">
                        ({h.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} ={" "}
                        {formatCurrency(h.usdValue)})
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Breakdown of what's being converted */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3.5 space-y-2.5">
            <div className="text-xs font-bold text-slate-300 flex items-center justify-between border-b border-slate-800/80 pb-2">
              <span>Selected Asset(s)</span>
              <span>USD Value</span>
            </div>

            {conversionItems.length === 0 ? (
              <p className="text-center text-xs text-amber-400/90 py-2">
                No active crypto balance found for this selection.
              </p>
            ) : (
              conversionItems.map((item) => (
                <div key={item.symbol} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <CryptoIcon symbol={item.symbol} size="xs" />
                    <span className="font-semibold text-slate-200">
                      {item.qty.toLocaleString(undefined, { maximumFractionDigits: item.decimals })}{" "}
                      {item.symbol}
                    </span>
                  </div>
                  <span className="font-bold text-emerald-400 tabular-nums">
                    +$
                    {item.usdValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{" "}
                    USD
                  </span>
                </div>
              ))
            )}

            <div className="border-t border-slate-800 pt-2 flex items-center justify-between text-sm">
              <span className="font-extrabold text-slate-200">Total Live Balance Credit:</span>
              <span className="font-black text-emerald-400 text-base tabular-nums">
                +$
                {totalUsdToCredit.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          </div>

          {/* Value Destination Card */}
          <div className="rounded-xl bg-gradient-to-r from-emerald-950/60 via-teal-950/40 to-slate-900 border border-emerald-500/30 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0">
              <DollarSign className="h-5 w-5" />
            </div>
            <div className="text-xs">
              <div className="font-bold text-emerald-300">Credited to Live Trading Balance</div>
              <div className="text-slate-400">
                Instantly usable for live orders, margin trading, signals & withdrawals.
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            className="flex-1 border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
            onClick={() => onOpenChange(false)}
            disabled={isConverting}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-extrabold shadow-lg shadow-emerald-600/20 hover:from-emerald-400 hover:to-teal-500"
            onClick={handleConvert}
            disabled={isConverting || conversionItems.length === 0 || totalUsdToCredit <= 0}
          >
            {isConverting ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {isConverting ? "Converting..." : "Convert to Live Balance"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
