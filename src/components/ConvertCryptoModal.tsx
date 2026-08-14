import { useState, useMemo, useEffect } from "react";
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
import { RefreshCw, Sparkles, DollarSign, ArrowRight } from "lucide-react";
import { CryptoIcon } from "@/components/CryptoIcon";

const SUPPORTED_CRYPTO = [
  { symbol: "BTC", name: "Bitcoin", icon: "₿", decimals: 6 },
  { symbol: "ETH", name: "Ethereum", icon: "Ξ", decimals: 5 },
  { symbol: "SOL", name: "Solana", icon: "◎", decimals: 4 },
  { symbol: "BNB", name: "BNB", icon: "B", decimals: 4 },
  { symbol: "XRP", name: "Ripple", icon: "✕", decimals: 2 },
  { symbol: "ADA", name: "Cardano", icon: "₳", decimals: 2 },
  { symbol: "DOGE", name: "Dogecoin", icon: "Ð", decimals: 2 },
  { symbol: "USDT", name: "Tether USD", icon: "₮", decimals: 2 },
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
  const { formatCurrency } = useCurrency();
  const qc = useQueryClient();
  const { tickers } = useBinancePrices(PRICE_SYMBOLS);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(defaultSymbol);
  const [isConverting, setIsConverting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedSymbol(defaultSymbol || "ALL");
    }
  }, [open, defaultSymbol]);

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

  // Fetch profile for json crypto_balances and cash balance
  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("available_cash, live_balance, account_balance, crypto_balances, is_suspended")
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
      const rowVal = rowMap.get(meta.symbol);
      const jsonVal = jsonBalances[meta.symbol] ?? jsonBalances[meta.symbol.toLowerCase()];
      const qty = Math.max(rowVal ?? 0, Number(jsonVal ?? 0));
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

  // Target conversion items
  const conversionItems = useMemo(() => {
    if (selectedSymbol === "ALL") {
      return holdings.filter((h) => h.qty > 0);
    }
    return holdings.filter((h) => h.symbol === selectedSymbol && h.qty > 0);
  }, [holdings, selectedSymbol]);

  const totalUsdToCredit = useMemo(() => {
    return conversionItems.reduce((acc, item) => acc + item.usdValue, 0);
  }, [conversionItems]);

  const allHoldingsValue = useMemo(() => {
    return holdings.reduce((sum, h) => sum + h.usdValue, 0);
  }, [holdings]);

  const handleConvert = async () => {
    if (!user) return;
    if ((profile as any)?.is_suspended) {
      toast.error("Account suspended — conversion is disabled. Contact support.");
      return;
    }
    if (conversionItems.length === 0 || totalUsdToCredit <= 0) {
      toast.error("No crypto holdings available to convert.");
      return;
    }

    setIsConverting(true);
    soundFX.playClick();
    soundFX.triggerHaptic(30);

    try {
      // 1. Fetch freshest profile state for atomic cash balance addition
      const { data: freshProfile, error: fetchErr } = await supabase
        .from("profiles")
        .select("available_cash, live_balance, account_balance, crypto_balances")
        .eq("id", user.id)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      const currentCash = Number(
        freshProfile?.available_cash ??
          freshProfile?.live_balance ??
          freshProfile?.account_balance ??
          0,
      );
      const newCash = Number((currentCash + totalUsdToCredit).toFixed(2));

      const updatedJson = {
        ...(((freshProfile as { crypto_balances?: Record<string, number> })?.crypto_balances ??
          {}) as Record<string, number>),
      };

      // 2. Debit the converted crypto assets from user_crypto_balances and profiles.crypto_balances
      if (selectedSymbol === "ALL") {
        // Zero all supported crypto balances
        for (const meta of SUPPORTED_CRYPTO) {
          await supabase.from("user_crypto_balances").upsert(
            {
              user_id: user.id,
              asset_symbol: meta.symbol,
              balance: 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,asset_symbol" },
          );
          updatedJson[meta.symbol] = 0;
          updatedJson[meta.symbol.toLowerCase()] = 0;
        }
      } else {
        // Zero the specific selected asset
        for (const item of conversionItems) {
          await supabase.from("user_crypto_balances").upsert(
            {
              user_id: user.id,
              asset_symbol: item.symbol,
              balance: 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,asset_symbol" },
          );
          updatedJson[item.symbol] = 0;
          updatedJson[item.symbol.toLowerCase()] = 0;
        }
      }

      // 3. Update profiles table: Credit Cash Balance and update crypto_balances
      const { error: profErr } = await supabase
        .from("profiles")
        .update({
          available_cash: newCash,
          account_balance: newCash,
          live_balance: newCash,
          crypto_balances: updatedJson as any,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);

      if (profErr) throw profErr;

      // 4. Record transaction log in transactions table
      const desc =
        conversionItems.length === 1
          ? `Converted ${conversionItems[0].qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${conversionItems[0].symbol} to ${formatCurrency(totalUsdToCredit)} Cash Balance`
          : `Converted crypto holdings (${conversionItems.map((c) => `${c.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${c.symbol}`).join(", ")}) to ${formatCurrency(totalUsdToCredit)} Cash Balance`;

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
        `Successfully converted crypto to ${formatCurrency(totalUsdToCredit)} Cash Balance!`,
      );

      // 5. Invalidate caches so UI across all screens immediately reflects the change
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["my_crypto_wallets"] });
      qc.invalidateQueries({ queryKey: ["user_profile_navbar"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });

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
            Convert Crypto to Cash Balance
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-300">
            Instantly convert your cryptocurrency holdings into USD Cash Balance with 0% conversion
            fees.
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
                  ✨ Convert ALL Crypto Holdings ({formatCurrency(allHoldingsValue)})
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
              <span>USD Cash Value</span>
            </div>

            {conversionItems.length === 0 ? (
              <p className="text-center text-xs text-amber-400/90 py-2">
                No crypto balance found for this selection.
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
                    +{formatCurrency(item.usdValue)}
                  </span>
                </div>
              ))
            )}

            <div className="border-t border-slate-800 pt-2 flex items-center justify-between text-sm">
              <span className="font-extrabold text-slate-200">Total Cash Credited:</span>
              <span className="font-black text-emerald-400 text-base tabular-nums">
                +{formatCurrency(totalUsdToCredit)}
              </span>
            </div>
          </div>

          {/* Value Destination Card */}
          <div className="rounded-xl bg-gradient-to-r from-emerald-950/60 via-teal-950/40 to-slate-900 border border-emerald-500/30 p-3 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0">
              <DollarSign className="h-5 w-5" />
            </div>
            <div className="text-xs">
              <div className="font-bold text-emerald-300">Credited to Cash Balance (USD)</div>
              <div className="text-slate-400">
                Instantly available for spot & futures trading, AI bots, and cash withdrawals.
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
            {isConverting ? "Converting..." : "Convert to Cash Balance"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
