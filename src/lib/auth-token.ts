import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

/**
 * Retrieves the current authenticated Supabase JWT access token for server calls.
 * Refreshes the session automatically if no active token is cached.
 */
export async function getAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) {
    return data.session.access_token;
  }
  const { data: refreshed } = await supabase.auth.refreshSession();
  if (refreshed.session?.access_token) {
    return refreshed.session.access_token;
  }
  throw new Error("Session expired. Please sign in again.");
}

/**
 * Wraps a TanStack Start server function so every invocation automatically
 * includes the caller's verified Supabase `accessToken` inside `data`.
 */
export function useAuthedServerFn<TFn extends (...args: never[]) => Promise<unknown>>(fn: TFn) {
  const rawFn = useServerFn(fn as never) as unknown as (opts: {
    data: Record<string, unknown>;
  }) => Promise<Awaited<ReturnType<TFn>>>;

  return useCallback(
    async (opts?: { data?: Record<string, unknown> }): Promise<Awaited<ReturnType<TFn>>> => {
      const accessToken = await getAccessToken();
      return rawFn({
        data: {
          ...(opts?.data ?? {}),
          accessToken,
        },
      });
    },
    [rawFn],
  );
}
