import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReconcileOptions {
  userId?: string;
  fallbackMode?: "demo" | "live";
  nowMs?: number;
}

export interface ReconcileSummary {
  botsUpdated: number;
  botsExpired: number;
  copyUpdated: number;
  copyExpired: number;
  totalProfitCredited: number;
  totalPrincipalReturned: number;
  settledOfflineCatchup: boolean;
}

interface PendingCredit {
  userId: string;
  mode: "demo" | "live";
  profitDelta: number;
  principalReturn: number;
}

interface PendingTransaction {
  user_id: string;
  type: string;
  amount: number;
  asset_name: string;
  status: string;
  account_mode: "demo" | "live";
  source_table?: string;
  source_id?: string;
}

function resolveMode(rawMode: unknown, fallbackMode: "demo" | "live"): "demo" | "live" {
  if (rawMode === "demo" || rawMode === "live") return rawMode;
  return fallbackMode;
}

function roundMoney4(val: number): number {
  return Number(val.toFixed(4));
}

function roundMoney2(val: number): number {
  return Number(val.toFixed(2));
}

export function formatRemainingDuration(expirationDateStr: string | number | Date): string {
  const expMs = new Date(expirationDateStr).getTime();
  if (!Number.isFinite(expMs)) return "Active";
  const diffMs = expMs - Date.now();
  if (diffMs <= 0) return "Expired";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${Math.max(1, minutes)}m left`;
}

export async function reconcilePositions(
  client: SupabaseClient<any>,
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const fallbackMode = options.fallbackMode ?? "live";

  const summary: ReconcileSummary = {
    botsUpdated: 0,
    botsExpired: 0,
    copyUpdated: 0,
    copyExpired: 0,
    totalProfitCredited: 0,
    totalPrincipalReturned: 0,
    settledOfflineCatchup: false,
  };

  let botsQuery = client
    .from("user_active_bots")
    .select(
      "*, trading_bots(name, hourly_payout, daily_payout, duration_days, min_roi, max_roi, payout_interval)",
    )
    .or("status.eq.active,status.eq.running");

  let copyQuery = client
    .from("user_copy_allocations")
    .select(
      "*, copy_trading_tiers(tier_name, strategist_name, monthly_roi_min, monthly_roi_max, lock_in_days)",
    )
    .or("status.eq.active,status.eq.running");

  if (options.userId) {
    botsQuery = botsQuery.eq("user_id", options.userId);
    copyQuery = copyQuery.eq("user_id", options.userId);
  }

  const [botsRes, copyRes] = await Promise.all([botsQuery, copyQuery]);
  const activeBots = (botsRes.data ?? []) as any[];
  const activeCopies = (copyRes.data ?? []) as any[];

  if (activeBots.length === 0 && activeCopies.length === 0) {
    return summary;
  }

  const creditsByBucket = new Map<string, PendingCredit>();
  const pendingTransactions: PendingTransaction[] = [];

  const addCredit = (
    userId: string,
    mode: "demo" | "live",
    profitDelta: number,
    principalReturn: number,
  ) => {
    const key = `${userId}:${mode}`;
    const existing = creditsByBucket.get(key) ?? {
      userId,
      mode,
      profitDelta: 0,
      principalReturn: 0,
    };
    existing.profitDelta = roundMoney4(existing.profitDelta + profitDelta);
    existing.principalReturn = roundMoney4(existing.principalReturn + principalReturn);
    creditsByBucket.set(key, existing);
  };

  // 1. Reconcile AI Trading Bots
  await Promise.all(
    activeBots.map(async (bot) => {
      try {
        const tb = bot.trading_bots;
        const invested = Number(bot.invested_amount) || 0;
        const activationMs = new Date(bot.activation_date || bot.created_at || nowMs).getTime();
        const durationDays = Math.max(1, Number(tb?.duration_days ?? 30));
        const rawExpMs = bot.expiration_date ? new Date(bot.expiration_date).getTime() : NaN;
        const expirationMs = Number.isFinite(rawExpMs)
          ? rawExpMs
          : activationMs + durationDays * 86400 * 1000;

        const rawLastPayoutMs = bot.last_payout_at
          ? new Date(bot.last_payout_at).getTime()
          : activationMs;
        const lastPayoutMs = Math.max(
          activationMs,
          Number.isFinite(rawLastPayoutMs) ? rawLastPayoutMs : activationMs,
        );

        const isExpired = nowMs >= expirationMs;
        const effectiveNowMs = Math.min(nowMs, expirationMs);
        const elapsedSeconds = Math.max(0, (effectiveNowMs - lastPayoutMs) / 1000);

        const hourlyFromTb = Number(tb?.hourly_payout) || 0;
        const dailyFromTb = Number(tb?.daily_payout) || 0;
        const hourly = hourlyFromTb || (dailyFromTb ? dailyFromTb / 24 : (invested * 0.1) / 24);
        const perSecondRate = hourly / 3600;

        const rawAccrued = perSecondRate * elapsedSeconds;
        const accruedProfit =
          rawAccrued >= 0.0001 || (isExpired && rawAccrued > 0) ? roundMoney4(rawAccrued) : 0;

        if (!isExpired && accruedProfit <= 0) {
          return;
        }

        const prevProfit = Number(bot.current_profit || 0);
        const nextProfit = roundMoney4(prevProfit + accruedProfit);
        const nextStatus = isExpired ? "completed" : bot.status;
        const nextLastPayoutIso = new Date(Math.max(lastPayoutMs, effectiveNowMs)).toISOString();

        let updateQuery = client
          .from("user_active_bots")
          .update({
            current_profit: nextProfit,
            last_payout_at: nextLastPayoutIso,
            status: nextStatus,
          } as never)
          .eq("id", bot.id)
          .eq("status", bot.status);

        if (bot.last_payout_at) {
          updateQuery = updateQuery.eq("last_payout_at", bot.last_payout_at);
        }

        const { data: claimed, error: claimErr } = await updateQuery.select("id").maybeSingle();
        if (claimErr || !claimed) {
          return;
        }

        const mode = resolveMode(bot.account_mode, fallbackMode);
        const principalReturn = isExpired ? invested : 0;

        summary.botsUpdated += 1;
        if (isExpired) summary.botsExpired += 1;
        if (elapsedSeconds >= 90 && accruedProfit > 0) summary.settledOfflineCatchup = true;
        if (isExpired) summary.settledOfflineCatchup = true;

        if (accruedProfit > 0 || principalReturn > 0) {
          addCredit(bot.user_id, mode, accruedProfit, principalReturn);
        }

        const botName = tb?.name ?? "AI Trading Bot";
        if (accruedProfit >= 0.01 && (elapsedSeconds >= 120 || isExpired)) {
          pendingTransactions.push({
            user_id: bot.user_id,
            type: "bot_profit",
            amount: roundMoney2(accruedProfit),
            asset_name: `${botName} (${isExpired ? "Final Accrual" : "Offline Catch-Up"})`,
            status: "completed",
            account_mode: mode,
          });
        }

        if (isExpired && principalReturn > 0) {
          pendingTransactions.push({
            user_id: bot.user_id,
            type: "bot_principal_return",
            amount: roundMoney2(principalReturn),
            asset_name: `${botName} — Principal Returned`,
            status: "completed",
            account_mode: mode,
            source_table: "user_active_bots",
            source_id: bot.id,
          });
        }
      } catch (err) {
        console.error("[ReconcileBotError]", err);
      }
    }),
  );

  // 2. Reconcile Copy Trading Allocations
  await Promise.all(
    activeCopies.map(async (alloc) => {
      try {
        const tier = alloc.copy_trading_tiers;
        const allocated = Number(alloc.allocated_amount) || 0;
        const createdMs = new Date(alloc.created_at || nowMs).getTime();
        const lockInDays = Math.max(1, Number(tier?.lock_in_days ?? 30));
        const expirationMs = createdMs + lockInDays * 86400 * 1000;

        const isExpired = nowMs >= expirationMs;
        const effectiveNowMs = Math.min(nowMs, expirationMs);
        const totalElapsedSeconds = Math.max(0, (effectiveNowMs - createdMs) / 1000);

        const avgMonthlyRoi =
          (Number(tier?.monthly_roi_min ?? 10) + Number(tier?.monthly_roi_max ?? 20)) / 2;
        const dailyProfit = (allocated * (avgMonthlyRoi / 100)) / 30;
        const perSecondRate = dailyProfit / 86400;

        const targetProfit = roundMoney4(perSecondRate * totalElapsedSeconds);
        const prevProfit = Number(alloc.current_profit || 0);
        const rawDelta = Math.max(0, targetProfit - prevProfit);
        const accruedProfit =
          rawDelta >= 0.0001 || (isExpired && rawDelta > 0) ? roundMoney4(rawDelta) : 0;

        if (!isExpired && accruedProfit <= 0) {
          return;
        }

        const nextProfit = roundMoney4(prevProfit + accruedProfit);
        const nextStatus = isExpired ? "completed" : alloc.status;

        const { data: claimed, error: claimErr } = await client
          .from("user_copy_allocations")
          .update({
            current_profit: nextProfit,
            status: nextStatus,
          } as never)
          .eq("id", alloc.id)
          .eq("status", alloc.status)
          .eq("current_profit", alloc.current_profit)
          .select("id")
          .maybeSingle();

        if (claimErr || !claimed) {
          return;
        }

        const mode = resolveMode(alloc.account_mode, fallbackMode);
        const principalReturn = isExpired ? allocated : 0;

        summary.copyUpdated += 1;
        if (isExpired) summary.copyExpired += 1;
        if (accruedProfit > Math.max(0.01, perSecondRate * 90)) {
          summary.settledOfflineCatchup = true;
        }
        if (isExpired) summary.settledOfflineCatchup = true;

        if (accruedProfit > 0 || principalReturn > 0) {
          addCredit(alloc.user_id, mode, accruedProfit, principalReturn);
        }

        const tierLabel = tier?.tier_name
          ? `${tier.tier_name}${tier?.strategist_name ? ` (${tier.strategist_name})` : ""}`
          : "Copy Trading";

        if (
          accruedProfit >= 0.01 &&
          (accruedProfit > Math.max(0.01, perSecondRate * 90) || isExpired)
        ) {
          pendingTransactions.push({
            user_id: alloc.user_id,
            type: "copy_profit",
            amount: roundMoney2(accruedProfit),
            asset_name: `${tierLabel} (${isExpired ? "Final Accrual" : "Offline Catch-Up"})`,
            status: "completed",
            account_mode: mode,
          });
        }

        if (isExpired && principalReturn > 0) {
          pendingTransactions.push({
            user_id: alloc.user_id,
            type: "copy_principal_return",
            amount: roundMoney2(principalReturn),
            asset_name: `${tierLabel} — Principal Returned`,
            status: "completed",
            account_mode: mode,
            source_table: "user_copy_allocations",
            source_id: alloc.id,
          });
        }
      } catch (err) {
        console.error("[ReconcileCopyError]", err);
      }
    }),
  );

  // 3. Apply batched balance updates per (userId, mode) WITHOUT bumping updated_at (preserves online presence accuracy)
  for (const credit of creditsByBucket.values()) {
    const totalCredit = roundMoney4(credit.profitDelta + credit.principalReturn);
    if (totalCredit <= 0) continue;

    summary.totalProfitCredited = roundMoney4(summary.totalProfitCredited + credit.profitDelta);
    summary.totalPrincipalReturned = roundMoney4(
      summary.totalPrincipalReturned + credit.principalReturn,
    );

    const { data: prof, error: profErr } = await client
      .from("profiles")
      .select("live_balance, account_balance, available_cash, demo_balance")
      .eq("id", credit.userId)
      .maybeSingle();

    if (profErr || !prof) continue;

    if (credit.mode === "demo") {
      const currentBal = Number((prof as any).demo_balance ?? 10000);
      const nextBal = roundMoney4(currentBal + totalCredit);
      await client
        .from("profiles")
        .update({ demo_balance: nextBal } as never)
        .eq("id", credit.userId);
    } else {
      const currentBal = Number(
        (prof as any).live_balance ??
          (prof as any).account_balance ??
          (prof as any).available_cash ??
          0,
      );
      const nextBal = roundMoney4(currentBal + totalCredit);
      await client
        .from("profiles")
        .update({
          live_balance: nextBal,
          account_balance: nextBal,
          available_cash: nextBal,
        } as never)
        .eq("id", credit.userId);
    }
  }

  // 4. Write audit transactions (with safe fallback if optional columns differ)
  for (const tx of pendingTransactions) {
    const { error } = await client.from("transactions").insert(tx as never);
    if (error) {
      await client.from("transactions").insert({
        user_id: tx.user_id,
        type: tx.type,
        amount: tx.amount,
        asset_name: tx.asset_name,
        status: tx.status,
      } as never);
    }
  }

  return summary;
}
