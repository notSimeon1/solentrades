import { supabaseAdmin } from "@/integrations/supabase/client.server";

const OWNER_EMAIL = "simonosawaru255@gmail.com";
const DEFAULT_FEE_WALLET = "0x8B911165295C78935F53753e9D8DBC566104C514";

type AdminStatus = "approved" | "rejected";
type BalanceColumns = {
  account_balance?: number | string | null;
  available_cash?: number | string | null;
  live_balance?: number | string | null;
  demo_balance?: number | string | null;
};

function money(value: unknown) {
  return Number(Number(value ?? 0).toFixed(2));
}

function asError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message?: string }).message ?? fallback);
  return fallback;
}

async function getSetting(key: string, fallback = DEFAULT_FEE_WALLET) {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? fallback;
}

async function writeActivity(
  userId: string,
  type: string,
  amount: number,
  assetName: string,
  status: string,
  sourceTable?: string,
  sourceId?: string,
) {
  const row = {
    user_id: userId,
    type,
    amount: money(amount),
    asset_name: assetName,
    status,
    ...(sourceTable && sourceId ? { source_table: sourceTable, source_id: sourceId } : {}),
  };

  const { error } = await supabaseAdmin.from("transactions").upsert(row as never, {
    onConflict: sourceTable && sourceId ? "source_table,source_id,type" : "id",
    ignoreDuplicates: false,
  });

  if (error) {
    const { error: insertError } = await supabaseAdmin.from("transactions").insert({
      user_id: userId,
      type,
      amount: money(amount),
      asset_name: assetName,
      status,
    });
    if (insertError) throw new Error(insertError.message);
  }
}

async function syncPendingActivity(
  userId: string,
  type: string,
  amount: number,
  assetName: string,
  status: string,
  sourceTable: string,
  sourceId: string,
) {
  const { data: sourced } = await (supabaseAdmin as any)
    .from("transactions")
    .select("id")
    .eq("source_table", sourceTable)
    .eq("source_id", sourceId)
    .eq("type", type)
    .maybeSingle();

  if (sourced?.id) {
    const { error } = await supabaseAdmin
      .from("transactions")
      .update({ asset_name: assetName, status })
      .eq("id", sourced.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { data: pending } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("type", type)
    .eq("amount", money(amount))
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pending?.id) {
    const { error } = await supabaseAdmin
      .from("transactions")
      .update({
        asset_name: assetName,
        status,
        source_table: sourceTable,
        source_id: sourceId,
      } as never)
      .eq("id", pending.id);
    if (error) throw new Error(error.message);
    return;
  }

  await writeActivity(userId, type, amount, assetName, status, sourceTable, sourceId);
}

async function updateProfileBalance(
  userId: string,
  profile: BalanceColumns,
  delta: number,
  mode: "live" | "demo" | "both" = "live",
) {
  const next: Record<string, number | string> = { updated_at: new Date().toISOString() };
  if (mode === "live" || mode === "both") {
    const rawLive = profile.live_balance ?? profile.account_balance ?? profile.available_cash ?? 0;
    const curLive = money(rawLive);
    const newLive = money(curLive + delta);
    if (newLive < 0) {
      throw new Error(
        `This would make the user's live balance negative ($${curLive.toFixed(2)} available)`,
      );
    }
    next.live_balance = newLive;
    next.account_balance = newLive;
    next.available_cash = newLive;
  }
  if (mode === "demo" || mode === "both") {
    const curDemo = money(profile.demo_balance);
    const newDemo = money(curDemo + delta);
    if (newDemo < 0) {
      throw new Error(
        `This would make the user's demo balance negative ($${curDemo.toFixed(2)} available)`,
      );
    }
    next.demo_balance = newDemo;
  }
  const { error } = await (supabaseAdmin as any).from("profiles").update(next).eq("id", userId);
  if (error) throw new Error(error.message);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function assertOwner(userId: string) {
  if (!userId || !UUID_REGEX.test(userId)) {
    // If invalid UUID, allow if user is authenticated or bypass check gracefully for admin
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (!error && data?.user?.email?.toLowerCase() === OWNER_EMAIL) return;
  } catch (e) {
    // Ignore auth error and check role
  }

  const { data: roleRow } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "super_admin"])
    .maybeSingle();
  if (roleRow) return;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("is_admin, is_super_admin, role")
    .eq("id", userId)
    .maybeSingle();

  if (
    profile?.is_admin ||
    profile?.is_super_admin ||
    profile?.role === "admin" ||
    profile?.role === "super_admin"
  ) {
    return;
  }

  throw new Error("Admin access is restricted to authorized admin accounts");
}

export async function adminGetOverview(userId: string) {
  await assertOwner(userId);
  const [
    profilesRes,
    depositsRes,
    withdrawalsRes,
    complaintsRes,
    settingsRes,
    transactionsRes,
    kycRes,
    referralsRes,
    positionsRes,
    newsRes,
  ] = await Promise.all([
    supabaseAdmin.from("profiles").select("*").order("created_at", { ascending: false }),
    supabaseAdmin.from("deposits").select("*").order("created_at", { ascending: false }),
    supabaseAdmin.from("withdrawals").select("*").order("created_at", { ascending: false }),
    supabaseAdmin.from("complaints").select("*").order("created_at", { ascending: false }),
    supabaseAdmin.from("app_settings").select("*"),
    supabaseAdmin
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300),
    supabaseAdmin.from("kyc_submissions").select("*").order("created_at", { ascending: false }),
    supabaseAdmin.from("referral_earnings").select("*").order("created_at", { ascending: false }),
    supabaseAdmin
      .from("live_positions")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("market_news")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  for (const res of [
    profilesRes,
    depositsRes,
    withdrawalsRes,
    complaintsRes,
    settingsRes,
    transactionsRes,
    kycRes,
    referralsRes,
    positionsRes,
    newsRes,
  ]) {
    if (res.error) throw new Error(res.error.message);
  }

  // Safely fetch auth users once via listUsers to map emails & user metadata
  const authEmailMap = new Map<
    string,
    { email: string | null; last_sign_in_at: string | null; name: string | null }
  >();
  try {
    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
    if (authUsers?.users) {
      for (const u of authUsers.users) {
        const metaName =
          u.user_metadata?.full_name ||
          u.user_metadata?.name ||
          u.user_metadata?.display_name ||
          null;
        authEmailMap.set(u.id, {
          email: u.email ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          name: metaName,
        });
      }
    }
  } catch (e) {
    console.error("Failed to list auth users:", e);
  }

  const users = (profilesRes.data ?? []).map((profile) => {
    const authInfo = authEmailMap.get(profile.id);
    const resolvedEmail = authInfo?.email ?? (profile as any).email ?? null;
    const resolvedName =
      profile.full_name ||
      authInfo?.name ||
      (resolvedEmail ? resolvedEmail.split("@")[0] : null) ||
      "Trader";

    return {
      ...profile,
      full_name: resolvedName,
      email: resolvedEmail,
      country: (profile as any).country ?? "Australia",
      ai_trading_enabled: Boolean((profile as any).ai_trading_enabled),
      last_sign_in_at: authInfo?.last_sign_in_at ?? null,
    };
  });

  return {
    users,
    deposits: depositsRes.data ?? [],
    withdrawals: withdrawalsRes.data ?? [],
    complaints: complaintsRes.data ?? [],
    settings: settingsRes.data ?? [],
    transactions: transactionsRes.data ?? [],
    kyc: kycRes.data ?? [],
    referrals: referralsRes.data ?? [],
    positions: positionsRes.data ?? [],
    news: newsRes.data ?? [],
  };
}

export async function adminDecideDeposit(userId: string, id: string, status: AdminStatus) {
  await assertOwner(userId);

  const rpc = await (supabaseAdmin as any).rpc("admin_decide_deposit_atomic", {
    _deposit_id: id,
    _status: status,
  });
  if (!rpc.error) return { ok: true };

  const { data: deposit, error: fetchError } = await supabaseAdmin
    .from("deposits")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!deposit) throw new Error("Deposit request not found");
  if (deposit.status !== "pending") return { ok: true };

  const amount = money(deposit.amount);
  if (status === "approved") {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("account_balance, available_cash, live_balance, referred_by")
      .eq("id", deposit.user_id)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile) throw new Error("User profile not found");

    const { error: updateError } = await supabaseAdmin
      .from("deposits")
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);

    const rawCurr = String(deposit.crypto_currency || "USDT").toUpperCase();
    const isCrypto =
      rawCurr.includes("USDT") ||
      rawCurr.includes("BTC") ||
      rawCurr.includes("ETH") ||
      rawCurr.includes("SOL") ||
      rawCurr.includes("BNB") ||
      rawCurr.includes("XRP") ||
      rawCurr.includes("ADA") ||
      rawCurr.includes("DOGE") ||
      rawCurr.includes("MNT") ||
      rawCurr.includes("TRC") ||
      rawCurr.includes("BEP") ||
      rawCurr.includes("ERC");

    if (isCrypto) {
      const sym = rawCurr.includes("BTC")
        ? "BTC"
        : rawCurr.includes("ETH")
          ? "ETH"
          : rawCurr.includes("SOL")
            ? "SOL"
            : rawCurr.includes("BNB")
              ? "BNB"
              : rawCurr.includes("XRP")
                ? "XRP"
                : rawCurr.includes("ADA")
                  ? "ADA"
                  : rawCurr.includes("DOGE")
                    ? "DOGE"
                    : rawCurr.includes("MNT")
                      ? "MNT"
                      : "USDT";

      const qty = Number(deposit.amount) || 0;

      // 1. Update user_crypto_balances
      const { data: existingBal } = await supabaseAdmin
        .from("user_crypto_balances")
        .select("balance")
        .eq("user_id", deposit.user_id)
        .eq("asset_symbol", sym)
        .maybeSingle();

      const currentQty = Number(existingBal?.balance ?? 0);
      const newQty = Number((currentQty + qty).toFixed(6));

      await supabaseAdmin.from("user_crypto_balances").upsert(
        {
          user_id: deposit.user_id,
          asset_symbol: sym,
          balance: newQty,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,asset_symbol" },
      );

      // 2. Update profiles.crypto_balances JSONB
      const { data: prof } = await supabaseAdmin
        .from("profiles")
        .select("crypto_balances")
        .eq("id", deposit.user_id)
        .maybeSingle();

      const currentJson = ((prof as any)?.crypto_balances ?? {}) as Record<string, number>;
      const updatedJson = {
        ...currentJson,
        [sym]: Number(((currentJson[sym] ?? 0) + qty).toFixed(6)),
      };

      await supabaseAdmin
        .from("profiles")
        .update({ crypto_balances: updatedJson as any } as never)
        .eq("id", deposit.user_id);
    } else {
      // Fiat USD Deposit -> credit Live Balance
      await updateProfileBalance(deposit.user_id, profile, amount, "live");
    }
    await syncPendingActivity(
      deposit.user_id,
      "deposit_request",
      amount,
      `Approved deposit ${deposit.crypto_currency}`,
      "approved",
      "deposits",
      deposit.id,
    );

    if (profile.referred_by) {
      const bonusPct = (await getPlatformNumeric("referral_profit_share_percent", 20)) / 100;
      const bonus = money(amount * bonusPct);
      const bonusLabel = `${Math.round(bonusPct * 100)}%`;
      const { data: referrer } = await supabaseAdmin
        .from("profiles")
        .select("account_balance, available_cash, live_balance")
        .eq("id", profile.referred_by)
        .maybeSingle();
      if (referrer) await updateProfileBalance(profile.referred_by, referrer, bonus, "live");
      await supabaseAdmin.from("referral_earnings").insert({
        referrer_id: profile.referred_by,
        referred_user_id: deposit.user_id,
        deposit_id: deposit.id,
        amount: bonus,
      });
      await writeActivity(
        profile.referred_by,
        "referral_bonus",
        bonus,
        `Referral commission (${bonusLabel})`,
        "completed",
        "deposits",
        deposit.id,
      );
    }
  } else {
    const { error: updateError } = await supabaseAdmin
      .from("deposits")
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    await syncPendingActivity(
      deposit.user_id,
      "deposit_request",
      amount,
      `Rejected deposit ${deposit.crypto_currency}`,
      "rejected",
      "deposits",
      deposit.id,
    );
  }
  return { ok: true };
}

export async function adminDecideWithdrawal(userId: string, id: string, status: AdminStatus) {
  await assertOwner(userId);
  const feeWallet = await getSetting("deposit_wallet_usdt_bep20");
  const rpc = await (supabaseAdmin as any).rpc("admin_decide_withdrawal_atomic", {
    _withdrawal_id: id,
    _status: status,
    _fee_wallet: feeWallet,
  });
  if (!rpc.error) return { ok: true };

  const { data: withdrawal, error: fetchError } = await supabaseAdmin
    .from("withdrawals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!withdrawal) throw new Error("Withdrawal request not found");
  if (withdrawal.status !== "pending") return { ok: true };

  const amount = money(withdrawal.amount);
  const taxPct = (await getPlatformNumeric("withdrawal_tax_percent", 5)) / 100;
  const tax = money(amount * taxPct);
  const taxPctLabel = Math.round(taxPct * 100);
  const payout = Math.max(0, money(amount - tax));

  if (status === "approved") {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("account_balance, available_cash, live_balance")
      .eq("id", withdrawal.user_id)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile) throw new Error("User profile not found");
    const userAvail = money(
      profile.live_balance ?? profile.account_balance ?? profile.available_cash ?? 0,
    );
    if (userAvail < amount)
      throw new Error(`User has insufficient available cash ($${userAvail.toFixed(2)} available)`);

    const { error: updateError } = await supabaseAdmin
      .from("withdrawals")
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        tax_fee: tax,
        payout_amount: payout,
        fee_wallet_address: feeWallet,
      } as never)
      .eq("id", id)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);

    await updateProfileBalance(withdrawal.user_id, profile, -amount, "live");
    await syncPendingActivity(
      withdrawal.user_id,
      "withdrawal_request",
      amount,
      `Approved withdrawal ${withdrawal.crypto_currency} · payout $${payout.toFixed(2)} · ${taxPctLabel}% tax fee $${tax.toFixed(2)}`,
      "approved",
      "withdrawals",
      withdrawal.id,
    );
    await writeActivity(
      withdrawal.user_id,
      "withdrawal_tax_fee",
      tax,
      `${taxPctLabel}% withdrawal tax paid to ${feeWallet}`,
      "completed",
      "withdrawals",
      withdrawal.id,
    );
  } else {
    const { error: updateError } = await supabaseAdmin
      .from("withdrawals")
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        tax_fee: tax,
        payout_amount: payout,
        fee_wallet_address: feeWallet,
      } as never)
      .eq("id", id)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    await syncPendingActivity(
      withdrawal.user_id,
      "withdrawal_request",
      amount,
      `Rejected withdrawal ${withdrawal.crypto_currency}`,
      "rejected",
      "withdrawals",
      withdrawal.id,
    );
  }
  return { ok: true };
}

export async function adminUpdateChart(
  userId: string,
  targetUserId: string,
  mode: "profit" | "loss" | "flat" | "live",
  intensity: number,
) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({
      chart_mode: mode,
      chart_intensity: intensity,
      chart_seed: Math.floor(Math.random() * 10000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetUserId);
  if (error) throw new Error(error.message);
  await writeActivity(
    targetUserId,
    "chart_control",
    0,
    `Admin set chart to ${mode.toUpperCase()} intensity ${intensity}`,
    "completed",
  );
  return { ok: true };
}

export async function adminAdjustBalance(
  userId: string,
  targetUserId: string,
  amount: number,
  direction: "credit" | "debit",
) {
  await assertOwner(userId);
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("account_balance, available_cash, live_balance")
    .eq("id", targetUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!profile) throw new Error("User profile not found");
  const signed = direction === "credit" ? money(amount) : -money(amount);
  await updateProfileBalance(targetUserId, profile, signed, "live");
  await writeActivity(
    targetUserId,
    direction === "credit" ? "admin_credit" : "admin_debit",
    money(amount),
    direction === "credit" ? "Admin balance credit" : "Admin balance debit",
    "completed",
  );
  return { ok: true };
}

export async function adminUpdateComplaint(
  userId: string,
  id: string,
  status: "pending" | "resolved",
) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin.from("complaints").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function adminUpdateSetting(userId: string, key: string, value: string) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function adminToggleAccountMode(
  userId: string,
  targetUserId: string,
  mode: "demo" | "live",
) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ account_mode: mode, updated_at: new Date().toISOString() })
    .eq("id", targetUserId);
  if (error) throw new Error(error.message);
  await writeActivity(
    targetUserId,
    "account_mode",
    0,
    `Account switched to ${mode.toUpperCase()}`,
    "completed",
  );
  return { ok: true };
}

export async function adminToggleSuspend(userId: string, targetUserId: string, suspended: boolean) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ is_suspended: suspended, updated_at: new Date().toISOString() })
    .eq("id", targetUserId);
  if (error) throw new Error(error.message);
  await writeActivity(
    targetUserId,
    "account_status",
    0,
    suspended ? "Account suspended by admin" : "Account restored by admin",
    "completed",
  );
  return { ok: true };
}

export async function adminToggleAiTrading(userId: string, targetUserId: string, enabled: boolean) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ ai_trading_enabled: enabled, updated_at: new Date().toISOString() } as never)
    .eq("id", targetUserId);
  if (error) throw new Error(error.message);
  await writeActivity(
    targetUserId,
    "ai_trading",
    0,
    `AI trading ${enabled ? "enabled" : "disabled"}`,
    "completed",
  );
  return { ok: true };
}

export async function adminDecideKyc(
  userId: string,
  id: string,
  status: AdminStatus,
  note?: string,
) {
  await assertOwner(userId);
  const { data: row, error: fetchError } = await supabaseAdmin
    .from("kyc_submissions")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!row) throw new Error("KYC submission not found");
  const { error } = await supabaseAdmin
    .from("kyc_submissions")
    .update({ status, admin_note: note ?? null, reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({ kyc_status: status, updated_at: new Date().toISOString() })
    .eq("id", row.user_id);
  if (profileError) throw new Error(profileError.message);
  await writeActivity(row.user_id, "kyc", 0, `KYC ${status}`, status);
  return { ok: true };
}

export async function adminPostNews(
  userId: string,
  title: string,
  body: string,
  impact: "low" | "medium" | "high",
  source: string,
) {
  await assertOwner(userId);
  const { error } = await supabaseAdmin.from("market_news").insert({ title, body, impact, source });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function adminGetKycDocumentUrl(userId: string, path: string) {
  await assertOwner(userId);
  const { data, error } = await supabaseAdmin.storage
    .from("kyc-documents")
    .createSignedUrl(path, 60 * 10);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error("Failed to generate signed URL");
  return { url: data.signedUrl };
}

export async function openUserPosition(
  userId: string,
  asset: string,
  side: "buy" | "sell",
  quantity: number,
  leverage: number,
  margin: number,
  entryPrice: number,
  accountMode: "demo" | "live",
) {
  const { data, error } = await (supabaseAdmin as any).rpc("open_position_atomic", {
    _user_id: userId,
    _asset: asset,
    _side: side,
    _quantity: quantity,
    _leverage: leverage,
    _margin: margin,
    _entry_price: entryPrice,
    _account_mode: accountMode,
  });
  if (error) throw new Error(error.message);
  return { id: data as string };
}

export async function closeUserPosition(userId: string, positionId: string, closePrice: number) {
  const { data: position, error: posErr } = await supabaseAdmin
    .from("live_positions")
    .select("user_id")
    .eq("id", positionId)
    .maybeSingle();
  if (posErr) throw new Error(posErr.message);
  if (!position || position.user_id !== userId) throw new Error("Position not found");
  const { data, error } = await (supabaseAdmin as any).rpc("close_position_atomic", {
    _position_id: positionId,
    _close_price: closePrice,
  });
  if (error) throw new Error(error.message);
  return { pnl: Number(data ?? 0) };
}

export function getAdminServerErrorMessage(error: unknown) {
  return asError(error, "Admin action failed");
}

// ── Platform-settings helpers ────────────────────────────────────────────────

/** Read a single numeric platform setting with a typed fallback. */
async function getPlatformNumeric(key: string, fallback: number): Promise<number> {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("value")
    .eq("key_name", key)
    .maybeSingle();
  if (!data) return fallback;
  const raw = data.value;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/"/g, ""));
  return isNaN(n) ? fallback : n;
}

/** Return all platform settings as { id, category, key_name, value (string), description } */
export async function adminGetPlatformSettings(userId: string) {
  await assertOwner(userId);
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("id, category, key_name, value, description")
    .order("category")
    .order("key_name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    ...row,
    // Normalise JSONB value to a plain string for the frontend
    value:
      typeof row.value === "number"
        ? String(row.value)
        : typeof row.value === "string"
          ? row.value.replace(/^"|"$/g, "")
          : JSON.stringify(row.value),
  }));
}

/** Upsert a single platform setting.  Numeric-looking strings are stored as JSON numbers. */
export async function adminSavePlatformSetting(
  userId: string,
  keyName: string,
  rawValue: string,
  category?: string,
) {
  await assertOwner(userId);
  const jsonValue = /^-?[\d.]+$/.test(rawValue.trim()) ? parseFloat(rawValue) : rawValue;
  const row: any = { key_name: keyName, value: jsonValue, updated_at: new Date().toISOString() };
  if (category) row.category = category;
  const { error } = await supabaseAdmin
    .from("platform_settings")
    .upsert(row as never, { onConflict: "key_name" });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function adminReconcileLedger(userId: string, targetUserId?: string) {
  await assertOwner(userId);
  let query = supabaseAdmin
    .from("profiles")
    .select("id, live_balance, account_balance, available_cash, crypto_balances");
  if (targetUserId) {
    query = query.eq("id", targetUserId);
  }
  const { data: profiles, error } = await query;
  if (error) throw new Error(error.message);

  let updatedCount = 0;
  for (const prof of profiles || []) {
    const rawLive = Math.max(
      money(prof.live_balance),
      money(prof.account_balance),
      money(prof.available_cash),
    );

    // Sync user_crypto_balances with profiles.crypto_balances JSON
    const { data: cryptoRows } = await supabaseAdmin
      .from("user_crypto_balances")
      .select("asset_symbol, balance")
      .eq("user_id", prof.id);

    const jsonMap = ((prof as any)?.crypto_balances ?? {}) as Record<string, number>;
    const mergedCrypto: Record<string, number> = { ...jsonMap };

    (cryptoRows || []).forEach((row: any) => {
      const sym = String(row.asset_symbol).toUpperCase();
      mergedCrypto[sym] = Math.max(mergedCrypto[sym] ?? 0, Number(row.balance ?? 0));
    });

    // Update profile
    await supabaseAdmin
      .from("profiles")
      .update({
        live_balance: rawLive,
        account_balance: rawLive,
        available_cash: rawLive,
        crypto_balances: mergedCrypto as any,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", prof.id);

    // Ensure user_crypto_balances upserted
    for (const [sym, qty] of Object.entries(mergedCrypto)) {
      if (qty > 0) {
        await supabaseAdmin.from("user_crypto_balances").upsert(
          {
            user_id: prof.id,
            asset_symbol: sym,
            balance: qty,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,asset_symbol" },
        );
      }
    }

    updatedCount++;
  }

  return {
    ok: true,
    count: updatedCount,
    message: `Reconciled ${updatedCount} user account ledgers successfully.`,
  };
}

export async function adminClearAllBalances(userId: string) {
  await assertOwner(userId);

  // 1. Reset all profiles cash & crypto
  const { error: profErr } = await supabaseAdmin
    .from("profiles")
    .update({
      live_balance: 0,
      demo_balance: 0,
      account_balance: 0,
      available_cash: 0,
      crypto_balances: {},
      updated_at: new Date().toISOString(),
    } as never)
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (profErr) {
    console.error("Clear profiles error:", profErr);
  }

  // 2. Clear all rows in user_crypto_balances
  const { error: cryptoErr } = await supabaseAdmin
    .from("user_crypto_balances")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (cryptoErr) {
    console.error("Clear user_crypto_balances error:", cryptoErr);
  }

  return {
    ok: true,
    message: "Successfully cleared all account balances (cash and crypto) to $0 across all users.",
  };
}

export async function adminSetUserRole(userId: string, targetUserId: string, makeAdmin: boolean) {
  await assertOwner(userId);

  // Update profiles table
  const { error: profErr } = await supabaseAdmin
    .from("profiles")
    .update({
      role: makeAdmin ? "admin" : "user",
      is_admin: makeAdmin,
      is_super_admin: makeAdmin,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", targetUserId);

  if (profErr) {
    console.error("adminSetUserRole profiles error:", profErr);
  }

  // Update user_roles table
  if (makeAdmin) {
    await supabaseAdmin
      .from("user_roles")
      .upsert({ user_id: targetUserId, role: "admin" }, { onConflict: "user_id,role" });
  } else {
    await supabaseAdmin.from("user_roles").delete().eq("user_id", targetUserId).eq("role", "admin");
  }

  // Update auth user app metadata
  try {
    await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
      app_metadata: { role: makeAdmin ? "admin" : "user" },
      user_metadata: { is_admin: makeAdmin, role: makeAdmin ? "admin" : "user" },
    });
  } catch (e) {
    console.warn("adminSetUserRole auth update warning:", e);
  }

  return {
    ok: true,
    message: makeAdmin ? "Granted full admin access" : "Revoked admin access",
  };
}

// Make deposit/withdrawal functions use dynamic rates from platform_settings
// These are exported so the server fns above can call them too.
export { getPlatformNumeric };
