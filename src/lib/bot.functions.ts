import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const activateBotServerFn = createServerFn({ method: "POST" })
  .validator(
    (data: { userId: string; botId: string; amount: number; mode: "demo" | "live" }) => data,
  )
  .handler(async ({ data }) => {
    try {
      // 1. Fetch bot definition
      const { data: bot, error: botFetchErr } = await supabaseAdmin
        .from("trading_bots" as any)
        .select("*")
        .eq("id", data.botId)
        .single();

      if (botFetchErr || !bot) {
        return { success: false, message: "Trading bot not found or inactive." };
      }

      const botData = bot as any;
      if (data.amount < Number(botData.capital_required || 0)) {
        return {
          success: false,
          message: `Minimum investment for ${botData.name} is $${botData.capital_required}`,
        };
      }

      // 2. Fetch user profile & check balance
      const balanceCol = data.mode === "demo" ? "demo_balance" : "live_balance";
      const { data: prof, error: profErr } = await supabaseAdmin
        .from("profiles" as any)
        .select(`id, ${balanceCol}`)
        .eq("id", data.userId)
        .single();

      if (profErr || !prof) {
        return { success: false, message: "User profile not found." };
      }

      const currentBalance = Number((prof as any)[balanceCol] ?? 0);
      if (currentBalance < data.amount) {
        return { success: false, message: `Insufficient ${data.mode} balance.` };
      }

      // 3. Deduct balance from profile
      const newBalance = currentBalance - data.amount;
      const { error: updateBalErr } = await supabaseAdmin
        .from("profiles" as any)
        .update({ [balanceCol]: newBalance, updated_at: new Date().toISOString() })
        .eq("id", data.userId);

      if (updateBalErr) {
        return { success: false, message: "Failed to deduct balance." };
      }

      // 4. Calculate payouts
      const minRoi = Number(botData.min_roi ?? 5);
      const maxRoi = Number(botData.max_roi ?? 15);
      const avgRoi = (minRoi + maxRoi) / 2;
      const dailyPayout = Number(botData.daily_payout ?? 0) || (data.amount * avgRoi) / 100;
      const hourlyPayout = Number(botData.hourly_payout ?? 0) || dailyPayout / 24;
      const durationDays = Number(botData.duration_days ?? 30);
      const expirationDate = new Date(
        Date.now() + durationDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      // 5. Insert active bot record
      const { error: activeBotErr } = await supabaseAdmin.from("user_active_bots" as any).insert({
        user_id: data.userId,
        bot_id: data.botId,
        invested_amount: data.amount,
        daily_payout: dailyPayout,
        hourly_payout: hourlyPayout,
        payout_interval: botData.payout_interval || "hourly",
        current_profit: 0,
        status: "active",
        account_mode: data.mode,
        activation_date: new Date().toISOString(),
        expiration_date: expirationDate,
        last_payout_at: new Date().toISOString(),
      });

      if (activeBotErr) {
        // Rollback balance update
        await supabaseAdmin
          .from("profiles" as any)
          .update({ [balanceCol]: currentBalance })
          .eq("id", data.userId);
        return { success: false, message: activeBotErr.message };
      }

      // 6. Record transaction
      await supabaseAdmin.from("transactions" as any).insert({
        user_id: data.userId,
        type: "bot_activation",
        amount: data.amount,
        asset_name: `Activated AI Bot: ${botData.name}`,
        status: "completed",
        account_mode: data.mode,
      });

      return {
        success: true,
        message: `${botData.name} activated successfully!`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err?.message || "Failed to activate trading bot.",
      };
    }
  });
