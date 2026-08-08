import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type AccountMode = "demo" | "live";

type AccountModeContextValue = {
  mode: AccountMode;
  balance: number;
  liveBalance: number;
  fiatLiveBalance: number;
  cashBalance: number;
  cryptoBalance: number;
  demoBalance: number;
  switchMode: (next: AccountMode) => Promise<void>;
  loading: boolean;
  refreshBalances: () => Promise<void>;
};

const AccountModeContext = createContext<AccountModeContextValue>({
  mode: "demo",
  balance: 0,
  liveBalance: 0,
  fiatLiveBalance: 0,
  cashBalance: 0,
  cryptoBalance: 0,
  demoBalance: 0,
  switchMode: async () => {},
  loading: true,
  refreshBalances: async () => {},
});

const FALLBACK_PRICES: Record<string, number> = {
  BTC: 96500,
  ETH: 3450,
  BNB: 650,
  SOL: 195,
  XRP: 2.45,
  ADA: 0.85,
  DOGE: 0.28,
  USDT: 1.0,
};

const COINGECKO_MAP: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  USDT: "tether",
};

export function AccountModeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [mode, setMode] = useState<AccountMode>("demo");
  const [fiatLiveBalance, setFiatLiveBalance] = useState(0);
  const [cryptoBalance, setCryptoBalance] = useState(0);
  const [liveBalance, setLiveBalance] = useState(0);
  const [demoBalance, setDemoBalance] = useState(10000);
  const [loading, setLoading] = useState(true);
  const [prices, setPrices] = useState<Record<string, number>>(FALLBACK_PRICES);

  // 1. Fetch live prices for valuation
  useEffect(() => {
    let cancelled = false;
    async function fetchPrices() {
      if (document.hidden) return;
      try {
        const symbols = [
          "BTCUSDT",
          "ETHUSDT",
          "BNBUSDT",
          "SOLUSDT",
          "XRPUSDT",
          "ADAUSDT",
          "DOGEUSDT",
        ];
        const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
          JSON.stringify(symbols),
        )}`;

        const res = await fetch(binanceUrl);
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          const next: Record<string, number> = { ...FALLBACK_PRICES };
          if (Array.isArray(data)) {
            data.forEach((d: any) => {
              if (d && d.symbol) {
                const base = d.symbol.replace(/USDT$/, "");
                next[base] = Number(d.lastPrice);
              }
            });
            next["USDT"] = 1.0;
            setPrices(next);
            return;
          }
        }

        // Coinbase Fallback
        const cbRes = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
        if (cbRes.ok) {
          const cbData = await cbRes.json();
          const rates = cbData?.data?.rates || {};
          if (cancelled) return;
          const next: Record<string, number> = { ...FALLBACK_PRICES };
          Object.keys(FALLBACK_PRICES).forEach((sym) => {
            if (rates[sym] && Number(rates[sym]) > 0) {
              next[sym] = Number((1 / Number(rates[sym])).toFixed(sym === "BTC" ? 2 : 4));
            }
          });
          next["USDT"] = 1.0;
          setPrices(next);
        }
      } catch (e) {
        // Fallback to defaults on error
      }
    }

    fetchPrices();
    const interval = setInterval(fetchPrices, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // 2. Fetch user balances (fiat + crypto assets)
  const fetchAllBalances = useCallback(async () => {
    if (!user) {
      setMode("demo");
      setFiatLiveBalance(0);
      setCryptoBalance(0);
      setLiveBalance(0);
      setDemoBalance(10000);
      setLoading(false);
      return;
    }

    try {
      const { data: prof } = await supabase
        .from("profiles")
        .select(
          "account_mode, live_balance, account_balance, available_cash, demo_balance, crypto_balances",
        )
        .eq("id", user.id)
        .maybeSingle();

      const { data: cryptoRows } = await supabase
        .from("user_crypto_balances")
        .select("asset_symbol, balance")
        .eq("user_id", user.id);

      const m = (prof?.account_mode as AccountMode) ?? "demo";
      const fiatLive = Number(
        prof?.live_balance ?? prof?.account_balance ?? prof?.available_cash ?? 0,
      );
      const demo = Number(prof?.demo_balance ?? 10000);

      const rowMap = new Map<string, number>();
      (cryptoRows ?? []).forEach((r: any) => {
        rowMap.set(String(r.asset_symbol).toUpperCase(), Number(r.balance ?? 0));
      });
      const jsonBalances = (prof?.crypto_balances ?? {}) as Record<string, number>;

      const allCryptoSymbols = new Set<string>([
        "BTC",
        "ETH",
        "BNB",
        "SOL",
        "XRP",
        "ADA",
        "DOGE",
        "USDT",
        ...Array.from(rowMap.keys()),
        ...Object.keys(jsonBalances),
      ]);

      let totalCryptoUsd = 0;
      allCryptoSymbols.forEach((sym) => {
        const symbolUpper = sym.toUpperCase();
        const qty = Math.max(
          rowMap.get(symbolUpper) ?? 0,
          Number(jsonBalances[symbolUpper] ?? 0),
          Number(jsonBalances[sym] ?? 0),
        );
        if (qty > 0) {
          const p =
            symbolUpper === "USDT"
              ? 1.0
              : (prices[`${symbolUpper}USDT`]?.price ??
                prices[symbolUpper]?.price ??
                FALLBACK_PRICES[symbolUpper] ??
                1.0);
          totalCryptoUsd += qty * p;
        }
      });

      const totalLive = Number((fiatLive + totalCryptoUsd).toFixed(2));

      setMode(m);
      setFiatLiveBalance(fiatLive);
      setCryptoBalance(totalCryptoUsd);
      setLiveBalance(totalLive);
      setDemoBalance(demo);
    } catch (err) {
      console.error("[AccountModeProvider] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user, prices]);

  useEffect(() => {
    fetchAllBalances();
  }, [fetchAllBalances]);

  // Realtime subscriptions for profiles & user_crypto_balances
  useEffect(() => {
    if (!user) return;

    const channelName = `acc_mode_${user.id}_${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles", filter: `id=eq.${user.id}` },
        () => fetchAllBalances(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_crypto_balances",
          filter: `user_id=eq.${user.id}`,
        },
        () => fetchAllBalances(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchAllBalances]);

  const switchMode = async (next: AccountMode) => {
    if (!user || next === mode) return;
    const { error } = await supabase
      .from("profiles")
      .update({ account_mode: next, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setMode(next);
    toast.success(`Switched to ${next.toUpperCase()} account`);
    qc.invalidateQueries({ queryKey: ["profile"] });
    qc.invalidateQueries({ queryKey: ["profile", user.id] });
    qc.invalidateQueries({ queryKey: ["my_crypto_wallets"] });
  };

  const balance = mode === "live" ? liveBalance : demoBalance;

  return (
    <AccountModeContext.Provider
      value={{
        mode,
        balance,
        liveBalance,
        fiatLiveBalance,
        cashBalance: fiatLiveBalance,
        cryptoBalance,
        demoBalance,
        switchMode,
        loading,
        refreshBalances: fetchAllBalances,
      }}
    >
      {children}
    </AccountModeContext.Provider>
  );
}

export function useAccountMode() {
  return useContext(AccountModeContext);
}
