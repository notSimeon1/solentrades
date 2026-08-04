import { useEffect, useRef, useState } from "react";

export type Ticker = {
  symbol: string;
  price: number;
  change: number;
  high: number;
  low: number;
  volume: number;
  direction: "up" | "down" | "flat";
};

const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "MNTUSDT",
  "DOGEUSDT",
];

const FALLBACK_PRICES: Record<string, { price: number; change: number }> = {
  BTCUSDT: { price: 64300, change: 0.75 },
  ETHUSDT: { price: 1875, change: 0.35 },
  BNBUSDT: { price: 594, change: 0.32 },
  SOLUSDT: { price: 74.2, change: 0.22 },
  XRPUSDT: { price: 1.08, change: -0.47 },
  ADAUSDT: { price: 0.19, change: -1.49 },
  MNTUSDT: { price: 0.78, change: 0.2 },
  DOGEUSDT: { price: 0.07, change: -0.04 },
  USDTUSDT: { price: 1.0, change: 0.0 },
};

export function useBinancePrices(symbols: string[] = DEFAULT_SYMBOLS) {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const prevRef = useRef<Record<string, number>>({});
  const symsKey = symbols.join(",");

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollInterval: NodeJS.Timeout | null = null;

    // Normalizing requested symbols
    const cleanSymbols = Array.from(
      new Set(
        symbols.map((s) => {
          const u = s.toUpperCase().trim();
          if (u === "USDT") return "USDTUSDT";
          return u.endsWith("USDT") ? u : `${u}USDT`;
        }),
      ),
    );

    const updateTicker = (
      sym: string,
      price: number,
      change: number = 0,
      high: number = 0,
      low: number = 0,
      volume: number = 0,
    ) => {
      if (cancelled || !price || isNaN(price)) return;
      const baseSym = sym.replace(/USDT$/, "");
      const previous = prevRef.current[sym] ?? price;
      const direction: Ticker["direction"] =
        price > previous ? "up" : price < previous ? "down" : "flat";
      prevRef.current[sym] = price;
      prevRef.current[baseSym] = price;

      const item: Ticker = {
        symbol: sym,
        price,
        change,
        high,
        low,
        volume,
        direction,
      };

      setTickers((prev) => ({
        ...prev,
        [sym]: item,
        [baseSym]: item,
      }));
    };

    // 1. Fetch via Binance REST API + Coinbase/CoinGecko fallback
    const fetchRestPrices = async () => {
      if (document.hidden) return;
      try {
        // Prepare USDT default
        updateTicker("USDTUSDT", 1.0, 0, 1.0, 1.0, 1000000);

        const binanceSymbols = cleanSymbols.filter((s) => s !== "USDTUSDT");
        if (binanceSymbols.length === 0) return;

        const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
          JSON.stringify(binanceSymbols),
        )}`;

        const res = await fetch(binanceUrl);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            data.forEach((d: any) => {
              if (d && d.symbol) {
                updateTicker(
                  d.symbol,
                  Number(d.lastPrice),
                  Number(d.priceChangePercent),
                  Number(d.highPrice),
                  Number(d.lowPrice),
                  Number(d.volume),
                );
              }
            });
            setStatus("live");
            return;
          }
        }

        // Secondary Fallback: Coinbase rates
        const cbRes = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
        if (cbRes.ok) {
          const cbData = await cbRes.json();
          const rates = cbData?.data?.rates || {};
          cleanSymbols.forEach((sym) => {
            const base = sym.replace(/USDT$/, "");
            if (rates[base]) {
              const rate = Number(rates[base]);
              if (rate > 0) {
                const usdPrice = Number((1 / rate).toFixed(base === "BTC" ? 2 : 4));
                updateTicker(sym, usdPrice);
              }
            }
          });
          setStatus("live");
          return;
        }

        throw new Error("REST price fetch failed");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        // Apply fallbacks for missing
        cleanSymbols.forEach((sym) => {
          const fb = FALLBACK_PRICES[sym] || FALLBACK_PRICES["BTCUSDT"];
          if (fb) updateTicker(sym, fb.price, fb.change);
        });
      }
    };

    // 2. Connect Binance Live Multi-Stream WebSocket
    const connectWebSocket = () => {
      try {
        const streamNames = cleanSymbols
          .filter((s) => s !== "USDTUSDT" && s !== "MNTUSDT")
          .map((s) => `${s.toLowerCase()}@ticker`);

        if (streamNames.length === 0) return;

        const wsUrl = `wss://stream.binance.com:9443/ws/${streamNames.join("/")}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          if (!cancelled) setStatus("live");
        };

        ws.onmessage = (event) => {
          if (cancelled) return;
          try {
            const data = JSON.parse(event.data);
            if (data && data.s && data.c) {
              updateTicker(
                data.s,
                Number(data.c),
                Number(data.P || 0),
                Number(data.h || 0),
                Number(data.l || 0),
                Number(data.v || 0),
              );
            }
          } catch (e) {
            // Ignore parse errors
          }
        };

        ws.onerror = () => {
          // Fail gracefully to REST polling
        };

        ws.onclose = () => {
          // Reconnect or fall back
        };
      } catch (e) {
        // Fall back
      }
    };

    // Execute immediately
    fetchRestPrices();
    connectWebSocket();

    // Backup polling every 4 seconds
    pollInterval = setInterval(fetchRestPrices, 4000);

    const handleVisibility = () => {
      if (!document.hidden) fetchRestPrices();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (ws) {
        ws.close();
        ws = null;
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [symsKey]);

  return { tickers, status };
}
