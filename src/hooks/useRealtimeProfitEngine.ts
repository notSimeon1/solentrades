import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useAccountMode } from "@/lib/account-mode-context";
import { reconcilePositions } from "@/lib/profit-reconciler";

export function useRealtimeProfitEngine() {
  const { user } = useAuth();
  const { mode } = useAccountMode();
  const qc = useQueryClient();
  const runningRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const syncPositions = async (notifyCatchup: boolean) => {
      if (runningRef.current || cancelled) return;
      runningRef.current = true;
      try {
        const res = await reconcilePositions(supabase, {
          userId: user.id,
          fallbackMode: mode,
        });

        if (cancelled) return;

        if (res.botsUpdated > 0 || res.copyUpdated > 0) {
          qc.invalidateQueries({ queryKey: ["profile"] });
          qc.invalidateQueries({ queryKey: ["my_active_bots"] });
          qc.invalidateQueries({ queryKey: ["my_copy_allocations"] });
          qc.invalidateQueries({ queryKey: ["transactions"] });
        }

        if (
          notifyCatchup &&
          res.settledOfflineCatchup &&
          (res.totalProfitCredited >= 0.01 || res.totalPrincipalReturned > 0)
        ) {
          const parts: string[] = [];
          if (res.totalProfitCredited >= 0.01) {
            parts.push(`+$${res.totalProfitCredited.toFixed(2)} offline profit accrued`);
          }
          if (res.totalPrincipalReturned > 0) {
            parts.push(`$${res.totalPrincipalReturned.toFixed(2)} principal returned on expiry`);
          }
          toast.success(parts.join(" · "));
        }
      } catch (e) {
        console.error("[RealtimeProfitEngine Error]", e);
      } finally {
        runningRef.current = false;
      }
    };

    // Immediate catch-up on login / page load
    void syncPositions(true);

    // Immediate catch-up when returning to the tab
    const onVisibility = () => {
      if (!document.hidden) {
        void syncPositions(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Live 15s heartbeat tick while tab is visible
    const interval = setInterval(() => {
      if (document.hidden) return;
      void syncPositions(false);
    }, 15000);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [user, mode, qc]);
}
