import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireVerifiedUser } from "./server-auth";
import { CRYPTO_FALLBACK_PRICES } from "./crypto-assets";

const SWAP_FEE_RATE = 0.002; // 0.2% network swap spread

async function fetchServerAssetUsdPrice(symbol: string): Promise<number> {
  const sym = symbol.toUpperCase().trim();
  if (sym === "USDT" || sym === "USDC") return 1.0;

  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = (await res.json()) as { price?: string };
      const p = Number(json?.price ?? 0);
      if (p > 0) return p;
    }
  } catch {
    // Fallback below
  }

  try {
    const res = await fetch(
      `https://min-api.cryptocompare.com/data/price?fsym=${encodeURIComponent(sym)}&tsyms=USD`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const json = (await res.json()) as { USD?: number };
      const p = Number(json?.USD ?? 0);
      if (p > 0) return p;
    }
  } catch {
    // Fallback to static map
  }

  return CRYPTO_FALLBACK_PRICES[sym] ?? 0;
}

const swapSchema = z.object({
  accessToken: z.string().min(1),
  fromSymbol: z.string().min(1).max(20),
  toSymbol: z.string().min(1).max(20),
  fromAmount: z.number().positive().max(1_000_000_000),
});

export const executeSwapServerFn = createServerFn({ method: "POST" })
  .validator((input) => swapSchema.parse(input))
  .handler(async ({ data }) => {
    const { userId } = await requireVerifiedUser(data.accessToken);
    const fromSym = data.fromSymbol.toUpperCase().trim();
    const toSym = data.toSymbol.toUpperCase().trim();
    const inputNum = Number(data.fromAmount);

    if (fromSym === toSym) {
      throw new Error("Select two different assets to swap.");
    }
    if (!Number.isFinite(inputNum) || inputNum <= 0) {
      throw new Error("Enter a valid positive swap amount.");
    }

    const [{ data: profile, error: profErr }, { data: balRows }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("crypto_balances, is_suspended")
        .eq("id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("user_crypto_balances")
        .select("asset_symbol, balance")
        .eq("user_id", userId)
        .in("asset_symbol", [fromSym, toSym]),
    ]);

    if (profErr || !profile) throw new Error("User profile not found.");
    if (profile.is_suspended) throw new Error("Account suspended — swaps are disabled.");

    const jsonMap = ((profile as { crypto_balances?: Record<string, number> }).crypto_balances ??
      {}) as Record<string, number>;
    const rowMap: Record<string, number> = {};
    (balRows ?? []).forEach((r) => {
      rowMap[String(r.asset_symbol).toUpperCase()] = Number(r.balance ?? 0);
    });

    const currentFromBal = Math.max(
      Number(rowMap[fromSym] ?? 0),
      Number(jsonMap[fromSym] ?? jsonMap[fromSym.toLowerCase()] ?? 0),
    );
    const currentToBal = Math.max(
      Number(rowMap[toSym] ?? 0),
      Number(jsonMap[toSym] ?? jsonMap[toSym.toLowerCase()] ?? 0),
    );

    if (inputNum > currentFromBal + 1e-9) {
      throw new Error(`Insufficient ${fromSym} balance.`);
    }

    const [fromPrice, toPrice] = await Promise.all([
      fetchServerAssetUsdPrice(fromSym),
      fetchServerAssetUsdPrice(toSym),
    ]);

    if (fromPrice <= 0 || toPrice <= 0) {
      throw new Error("Unable to resolve live market price for swap. Please try again.");
    }

    const grossOutput = (inputNum * fromPrice) / toPrice;
    const netOutput = Number((grossOutput * (1 - SWAP_FEE_RATE)).toFixed(8));
    if (netOutput <= 0) {
      throw new Error("Swap amount too small.");
    }

    const newFromBal = Number(Math.max(0, currentFromBal - inputNum).toFixed(8));
    const newToBal = Number((currentToBal + netOutput).toFixed(8));

    const updatedJson = {
      ...jsonMap,
      [fromSym]: newFromBal,
      [toSym]: newToBal,
    };

    const nowIso = new Date().toISOString();

    const [up1, up2, profUp] = await Promise.all([
      supabaseAdmin
        .from("user_crypto_balances")
        .upsert(
          { user_id: userId, asset_symbol: fromSym, balance: newFromBal, updated_at: nowIso },
          { onConflict: "user_id,asset_symbol" },
        ),
      supabaseAdmin
        .from("user_crypto_balances")
        .upsert(
          { user_id: userId, asset_symbol: toSym, balance: newToBal, updated_at: nowIso },
          { onConflict: "user_id,asset_symbol" },
        ),
      supabaseAdmin
        .from("profiles")
        .update({ crypto_balances: updatedJson as never, updated_at: nowIso })
        .eq("id", userId),
    ]);

    if (up1.error) throw new Error(up1.error.message);
    if (up2.error) throw new Error(up2.error.message);
    if (profUp.error) throw new Error(profUp.error.message);

    await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      type: "trade",
      amount: Number((inputNum * fromPrice).toFixed(2)),
      asset_name: `Instant Swap: ${inputNum.toFixed(4)} ${fromSym} → ${netOutput.toFixed(4)} ${toSym}`,
      status: "approved",
    } as never);

    return {
      ok: true,
      fromSymbol: fromSym,
      toSymbol: toSym,
      fromAmount: inputNum,
      netOutput,
      newFromBal,
      newToBal,
    };
  });

const copySubscribeSchema = z.object({
  accessToken: z.string().min(1),
  tierId: z.string().uuid(),
  allocatedAmount: z.number().positive().max(1_000_000),
  mode: z.enum(["demo", "live"]),
});

export const subscribeCopyTraderServerFn = createServerFn({ method: "POST" })
  .validator((input) => copySubscribeSchema.parse(input))
  .handler(async ({ data }) => {
    const { userId } = await requireVerifiedUser(data.accessToken);

    const [{ data: prof, error: profErr }, { data: tier, error: tierErr }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("is_suspended, demo_balance, live_balance, account_balance, available_cash")
        .eq("id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("copy_trading_tiers")
        .select("id, tier_name, required_capital")
        .eq("id", data.tierId)
        .maybeSingle(),
    ]);

    if (profErr || !prof) throw new Error("User profile not found.");
    if (prof.is_suspended) {
      throw new Error("Account suspended — copy trading is disabled. Contact support.");
    }
    if (tierErr || !tier) throw new Error("Copy trading tier not found.");

    const usd = Number(data.allocatedAmount);
    if (!Number.isFinite(usd) || usd < Number(tier.required_capital ?? 0)) {
      throw new Error(`Minimum allocation is $${tier.required_capital}`);
    }

    const currentBal =
      data.mode === "demo"
        ? Number(prof.demo_balance ?? 10000)
        : Number(prof.live_balance ?? prof.available_cash ?? prof.account_balance ?? 0);

    if (currentBal < usd) {
      throw new Error("Insufficient balance");
    }

    const newBal = Number((currentBal - usd).toFixed(2));
    const nowIso = new Date().toISOString();

    const updatePayload: Record<string, unknown> =
      data.mode === "demo"
        ? { demo_balance: newBal, updated_at: nowIso }
        : {
            live_balance: newBal,
            account_balance: newBal,
            available_cash: newBal,
            updated_at: nowIso,
          };

    const { error: balErr } = await supabaseAdmin
      .from("profiles")
      .update(updatePayload as never)
      .eq("id", userId);
    if (balErr) throw new Error(balErr.message);

    const { error: copyErr } = await supabaseAdmin.from("user_copy_allocations").insert({
      user_id: userId,
      tier_id: tier.id,
      allocated_amount: usd,
      current_profit: 0,
      status: "active",
      account_mode: data.mode,
    } as never);

    if (copyErr) {
      // Rollback deduction cleanly
      const rollbackPayload: Record<string, unknown> =
        data.mode === "demo"
          ? { demo_balance: currentBal }
          : {
              live_balance: currentBal,
              account_balance: currentBal,
              available_cash: currentBal,
            };
      await supabaseAdmin
        .from("profiles")
        .update(rollbackPayload as never)
        .eq("id", userId);
      throw new Error(copyErr.message);
    }

    await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      type: "copy_trade",
      amount: usd,
      asset_name: `Copy Trading: ${tier.tier_name}`,
      status: "completed",
      account_mode: data.mode,
    } as never);

    return { ok: true, tierName: tier.tier_name, newBalance: newBal };
  });

const convertToCashSchema = z.object({
  accessToken: z.string().min(1),
  symbol: z.string().min(1).max(20).default("ALL"),
});

export const convertCryptoToCashServerFn = createServerFn({ method: "POST" })
  .validator((input) => convertToCashSchema.parse(input))
  .handler(async ({ data }) => {
    const { userId } = await requireVerifiedUser(data.accessToken);
    const targetSymbol = data.symbol.toUpperCase().trim() || "ALL";

    const [{ data: profile, error: profErr }, { data: rows }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("available_cash, live_balance, account_balance, crypto_balances, is_suspended")
        .eq("id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("user_crypto_balances")
        .select("asset_symbol, balance")
        .eq("user_id", userId),
    ]);

    if (profErr || !profile) throw new Error("User profile not found.");
    if (profile.is_suspended) {
      throw new Error("Account suspended — conversion is disabled. Contact support.");
    }

    const jsonMap = ((profile as { crypto_balances?: Record<string, number> }).crypto_balances ??
      {}) as Record<string, number>;
    const rowMap: Record<string, number> = {};
    (rows ?? []).forEach((r) => {
      rowMap[String(r.asset_symbol).toUpperCase()] = Number(r.balance ?? 0);
    });

    const candidateSymbols = new Set<string>([
      ...Object.keys(rowMap),
      ...Object.keys(jsonMap).map((k) => k.toUpperCase()),
    ]);

    const itemsToConvert: Array<{ symbol: string; qty: number; usdValue: number }> = [];
    const symbolsList = targetSymbol === "ALL" ? Array.from(candidateSymbols) : [targetSymbol];

    const pricePairs = await Promise.all(
      symbolsList.map(async (sym) => [sym, await fetchServerAssetUsdPrice(sym)] as const),
    );
    const priceMap = new Map<string, number>(pricePairs);

    for (const sym of symbolsList) {
      const qty = Math.max(
        Number(rowMap[sym] ?? 0),
        Number(jsonMap[sym] ?? jsonMap[sym.toLowerCase()] ?? 0),
      );
      const price = priceMap.get(sym) ?? 0;
      if (qty > 0 && price > 0) {
        itemsToConvert.push({ symbol: sym, qty, usdValue: qty * price });
      }
    }

    const totalUsd = Number(itemsToConvert.reduce((sum, i) => sum + i.usdValue, 0).toFixed(2));
    if (itemsToConvert.length === 0 || totalUsd <= 0) {
      throw new Error("No crypto holdings available to convert.");
    }

    const currentCash = Number(
      profile.available_cash ?? profile.live_balance ?? profile.account_balance ?? 0,
    );
    const newCash = Number((currentCash + totalUsd).toFixed(2));
    const nowIso = new Date().toISOString();

    const updatedJson: Record<string, number> = { ...jsonMap };
    for (const item of itemsToConvert) {
      updatedJson[item.symbol] = 0;
      updatedJson[item.symbol.toLowerCase()] = 0;
    }

    await Promise.all(
      itemsToConvert.map((item) =>
        supabaseAdmin.from("user_crypto_balances").upsert(
          {
            user_id: userId,
            asset_symbol: item.symbol,
            balance: 0,
            updated_at: nowIso,
          },
          { onConflict: "user_id,asset_symbol" },
        ),
      ),
    );

    const { error: upErr } = await supabaseAdmin
      .from("profiles")
      .update({
        available_cash: newCash,
        account_balance: newCash,
        live_balance: newCash,
        crypto_balances: updatedJson as never,
        updated_at: nowIso,
      })
      .eq("id", userId);
    if (upErr) throw new Error(upErr.message);

    const desc =
      itemsToConvert.length === 1
        ? `Converted ${itemsToConvert[0].qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${itemsToConvert[0].symbol} to $${totalUsd.toFixed(2)} Cash Balance`
        : `Converted crypto holdings (${itemsToConvert.map((c) => `${c.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${c.symbol}`).join(", ")}) to $${totalUsd.toFixed(2)} Cash Balance`;

    await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      type: "swap",
      amount: totalUsd,
      asset_name: desc,
      status: "approved",
    } as never);

    return { ok: true, totalUsd, newCash, convertedCount: itemsToConvert.length };
  });
