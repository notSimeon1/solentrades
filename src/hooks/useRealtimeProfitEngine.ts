import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useAccountMode } from "@/lib/account-mode-context";

export function useRealtimeProfitEngine() {
  const { user } = useAuth();
  const { mode } = useAccountMode();
  const qc = useQueryClient();

  useEffect(() => {
    if (!user) return;

    const interval = setInterval(async () => {
      if (document.hidden) return;
      try {
        const balanceCol = mode === "demo" ? "demo_balance" : "live_balance";

        // 1. Fetch bots and copy allocations in parallel
        const [botsRes, copyRes] = await Promise.all([
          supabase
            .from("user_active_bots")
            .select("id, hourly_payout, daily_payout, current_profit")
            .eq("user_id", user.id)
            .eq("status", "active"),
          supabase
            .from("user_copy_allocations")
            .select("id, allocated_amount, current_profit")
            .eq("user_id", user.id)
            .eq("status", "active"),
        ]);

        const activeBots = botsRes.data || [];
        const copyAllocations = copyRes.data || [];

        if (activeBots.length === 0 && copyAllocations.length === 0) return;

        let totalBotCredit = 0;
        const botUpdates = activeBots.map(async (bot) => {
          const hourly = Number(bot.hourly_payout) || (Number(bot.daily_payout) || 12) / 24;
          const tickIncrement = Number((hourly / 360).toFixed(4));
          if (tickIncrement <= 0) return;

          const newProfit = Number((Number(bot.current_profit || 0) + tickIncrement).toFixed(4));
          totalBotCredit += tickIncrement;

          return supabase
            .from("user_active_bots")
            .update({ current_profit: newProfit } as never)
            .eq("id", bot.id);
        });

        let totalCopyCredit = 0;
        const copyUpdates = copyAllocations.map(async (alloc) => {
          const allocated = Number(alloc.allocated_amount) || 1000;
          const tickIncrement = Number((allocated * 0.00015).toFixed(4));
          if (tickIncrement <= 0) return;

          const newProfit = Number((Number(alloc.current_profit || 0) + tickIncrement).toFixed(4));
          totalCopyCredit += tickIncrement;

          return supabase
            .from("user_copy_allocations")
            .update({ current_profit: newProfit } as never)
            .eq("id", alloc.id);
        });

        await Promise.all([...botUpdates.filter(Boolean), ...copyUpdates.filter(Boolean)]);

        // Credit User Balance
        const totalCredit = Number((totalBotCredit + totalCopyCredit).toFixed(4));
        if (totalCredit > 0) {
          const { data: prof } = await supabase
            .from("profiles")
            .select(balanceCol)
            .eq("id", user.id)
            .single();

          const currentBal = Number((prof as any)?.[balanceCol] ?? 0);
          const newBal = Number((currentBal + totalCredit).toFixed(4));

          await supabase
            .from("profiles")
            .update({ [balanceCol]: newBal } as never)
            .eq("id", user.id);

          qc.invalidateQueries({ queryKey: ["profile"] });
          qc.invalidateQueries({ queryKey: ["my_active_bots"] });
          qc.invalidateQueries({ queryKey: ["my_copy_allocations"] });
        }
      } catch (e) {
        console.error("[RealtimeProfitEngine Error]", e);
      }
    }, 15000); // 15s interval for optimal DB RAM conservation

    return () => clearInterval(interval);
  }, [user, mode, qc]);
}
