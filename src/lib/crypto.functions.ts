import { createServerFn } from "@tanstack/react-start";

export const proxyCryptoPrices = createServerFn({ method: "GET" })
  .validator((symbols: string[]) => symbols)
  .handler(async ({ data: symbols }) => {
    const cleanSymbols = Array.from(
      new Set(
        symbols.map((s) => {
          const u = s.toUpperCase().trim();
          if (u === "USDT") return "USDTUSDT";
          return u.endsWith("USDT") ? u : `${u}USDT`;
        }),
      ),
    );

    const binanceSymbols = cleanSymbols.filter((s) => s !== "USDTUSDT");
    if (binanceSymbols.length === 0) return [];

    let results: any[] = [];

    // Try Binance Primary Endpoint
    try {
      const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
        JSON.stringify(binanceSymbols),
      )}`;

      const res = await fetch(binanceUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map((d: any) => ({
            symbol: d.symbol,
            price: Number(d.lastPrice),
            change: Number(d.priceChangePercent),
            high: Number(d.highPrice),
            low: Number(d.lowPrice),
            volume: Number(d.volume),
          }));
        }
      }
    } catch (e) {
      // Ignore
    }

    // Fallback Gateway 1: CryptoCompare
    try {
      const fsyms = Array.from(new Set(cleanSymbols.map((s) => s.replace(/USDT$/, "")))).join(",");
      const ccUrl = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${fsyms}&tsyms=USD`;
      const ccRes = await fetch(ccUrl, { signal: AbortSignal.timeout(5000) });
      if (ccRes.ok) {
        const ccData = await ccRes.json();
        if (ccData && ccData.RAW) {
          cleanSymbols.forEach((sym) => {
            const base = sym.replace(/USDT$/, "");
            const item = ccData.RAW[base]?.USD;
            if (item && item.PRICE) {
              results.push({
                symbol: sym,
                price: Number(item.PRICE),
                change: Number(item.CHANGEPCT24HOUR || 0),
                high: Number(item.HIGH24HOUR || 0),
                low: Number(item.LOW24HOUR || 0),
                volume: Number(item.VOLUME24HOUR || 0),
              });
            }
          });
          if (results.length > 0) return results;
        }
      }
    } catch (e) {
      // Ignore
    }

    // Fallback Gateway 2: Coinbase
    try {
      const cbRes = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD", {
        signal: AbortSignal.timeout(5000),
      });
      if (cbRes.ok) {
        const cbData = await cbRes.json();
        const rates = cbData?.data?.rates || {};
        cleanSymbols.forEach((sym) => {
          const base = sym.replace(/USDT$/, "");
          if (rates[base]) {
            const rate = Number(rates[base]);
            if (rate > 0) {
              const usdPrice = Number((1 / rate).toFixed(base === "BTC" ? 2 : 4));
              results.push({
                symbol: sym,
                price: usdPrice,
                change: 0,
                high: 0,
                low: 0,
                volume: 0,
              });
            }
          }
        });
        if (results.length > 0) return results;
      }
    } catch (e) {
      // Ignore
    }

    return results;
  });
