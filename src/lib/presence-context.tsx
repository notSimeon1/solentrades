import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  getSitePresenceSnapshot,
  leaveUserPresence,
  pingUserPresence,
} from "@/lib/presence.functions";

export type OnlineUserInfo = {
  userId: string;
  currentPath: string;
  onlineAt: string;
  tabCount: number;
};

type SitePresenceContextValue = {
  onlineUsers: Record<string, OnlineUserInfo>;
  lastSeenMap: Record<string, string>;
  connected: boolean;
};

const SitePresenceContext = createContext<SitePresenceContextValue>({
  onlineUsers: {},
  lastSeenMap: {},
  connected: false,
});

const PRESENCE_CHANNEL = "site-presence-v1";
const HEARTBEAT_INTERVAL_MS = 10_000;
const ADMIN_POLL_INTERVAL_MS = 4_000;

function getOrCreateTabId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    const existing = window.sessionStorage.getItem("solen_presence_tab_id");
    if (existing) return existing;
    const next =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    window.sessionStorage.setItem("solen_presence_tab_id", next);
    return next;
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

function buildRealtimeMap(
  state: Record<string, Array<Record<string, unknown>>>,
): Record<string, OnlineUserInfo> {
  const map: Record<string, OnlineUserInfo> = {};

  Object.entries(state).forEach(([key, presences]) => {
    if (!Array.isArray(presences) || presences.length === 0) return;

    let latest = presences[0];
    for (let i = 1; i < presences.length; i++) {
      const candidateTime = String(presences[i]?.online_at ?? "");
      const latestTime = String(latest?.online_at ?? "");
      if (candidateTime > latestTime) {
        latest = presences[i];
      }
    }

    const userId = String(latest?.user_id ?? key);
    if (!userId) return;

    map[userId] = {
      userId,
      currentPath: String(latest?.current_path ?? "/"),
      onlineAt: String(latest?.online_at ?? new Date().toISOString()),
      tabCount: presences.length,
    };
  });

  return map;
}

export function SitePresenceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });

  const pingFn = useServerFn(pingUserPresence);
  const leaveFn = useServerFn(leaveUserPresence);
  const snapshotFn = useServerFn(getSitePresenceSnapshot);

  const [realtimeUsers, setRealtimeUsers] = useState<Record<string, OnlineUserInfo>>({});
  const [serverUsers, setServerUsers] = useState<Record<string, OnlineUserInfo>>({});
  const [realtimeLastSeen, setRealtimeLastSeen] = useState<Record<string, string>>({});
  const [serverLastSeen, setServerLastSeen] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);
  const pathnameRef = useRef(pathname || "/");
  pathnameRef.current = pathname || "/";

  const tabIdRef = useRef<string>("");
  if (!tabIdRef.current && typeof window !== "undefined") {
    tabIdRef.current = getOrCreateTabId();
  }

  const pingRef = useRef(pingFn);
  pingRef.current = pingFn;
  const leaveRef = useRef(leaveFn);
  leaveRef.current = leaveFn;
  const snapshotRef = useRef(snapshotFn);
  snapshotRef.current = snapshotFn;

  const isAdminRoute = pathname.startsWith("/admin");

  // 1. Server HTTP Heartbeat + Lease (reliable across browsers, background tabs, and WebSocket drops)
  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setServerUsers({});
      setServerLastSeen({});
      return;
    }

    const tabId = tabIdRef.current || getOrCreateTabId();
    let active = true;

    const sendHeartbeat = () => {
      if (!active) return;
      pingRef
        .current({
          data: {
            userId,
            tabId,
            currentPath: pathnameRef.current || "/",
          },
        })
        .catch(() => {});
    };

    // Immediate heartbeat on sign-in
    sendHeartbeat();

    const interval = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    const handleVisibleOrFocus = () => {
      if (document.visibilityState === "visible") {
        sendHeartbeat();
      }
    };

    const handlePageHide = () => {
      leaveRef
        .current({
          data: {
            userId,
            tabId,
          },
        })
        .catch(() => {});
    };

    window.addEventListener("focus", handleVisibleOrFocus);
    document.addEventListener("visibilitychange", handleVisibleOrFocus);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleVisibleOrFocus);
      document.removeEventListener("visibilitychange", handleVisibleOrFocus);
      window.removeEventListener("pagehide", handlePageHide);
      leaveRef
        .current({
          data: {
            userId,
            tabId,
          },
        })
        .catch(() => {});
    };
  }, [user?.id]);

  // Send immediate server heartbeat when route changes
  useEffect(() => {
    if (!user?.id) return;
    const tabId = tabIdRef.current || getOrCreateTabId();
    pingRef
      .current({
        data: {
          userId: user.id,
          tabId,
          currentPath: pathname || "/",
        },
      })
      .catch(() => {});
  }, [user?.id, pathname]);

  // 2. Admin snapshot poller (only active on /admin routes so regular users make zero extra reads)
  useEffect(() => {
    if (!user?.id || !isAdminRoute) return;
    let active = true;

    const loadSnapshot = async () => {
      try {
        const res = await snapshotRef.current();
        if (!active || !res) return;
        setServerUsers(res.onlineUsers ?? {});
        setServerLastSeen(res.lastSeenMap ?? {});
      } catch {
        // Keep previous snapshot on transient fetch errors
      }
    };

    loadSnapshot();
    const interval = window.setInterval(loadSnapshot, ADMIN_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [user?.id, isAdminRoute]);

  // 3. Supabase Realtime Presence (fast-path WebSocket sync)
  useEffect(() => {
    if (!user?.id) {
      setRealtimeUsers({});
      setConnected(false);
      subscribedRef.current = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      return;
    }

    const channel = supabase.channel(PRESENCE_CHANNEL, {
      config: {
        presence: {
          key: user.id,
        },
      },
    });
    channelRef.current = channel;
    subscribedRef.current = false;

    const syncState = () => {
      const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
      setRealtimeUsers(buildRealtimeMap(state));
    };

    channel
      .on("presence", { event: "sync" }, syncState)
      .on("presence", { event: "join" }, syncState)
      .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
        const leftAt = new Date().toISOString();
        const userId = String(
          (leftPresences?.[0] as Record<string, unknown>)?.user_id ?? key ?? "",
        );
        const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
        const nextMap = buildRealtimeMap(state);
        setRealtimeUsers(nextMap);
        if (userId && !nextMap[userId]) {
          setRealtimeLastSeen((prev) => ({ ...prev, [userId]: leftAt }));
        }
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          subscribedRef.current = true;
          setConnected(true);
          try {
            await channel.track({
              user_id: user.id,
              current_path: pathnameRef.current || "/",
              online_at: new Date().toISOString(),
            });
          } catch {
            // Server heartbeat fallback handles presence if Realtime track fails
          }
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          subscribedRef.current = false;
          setConnected(false);
        }
      });

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && subscribedRef.current && channelRef.current) {
        channelRef.current
          .track({
            user_id: user.id,
            current_path: pathnameRef.current || "/",
            online_at: new Date().toISOString(),
          })
          .catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      subscribedRef.current = false;
      setConnected(false);
      channel.untrack().catch(() => {});
      supabase.removeChannel(channel);
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [user?.id]);

  // Update Realtime Presence route on navigation
  useEffect(() => {
    if (!user?.id || !subscribedRef.current || !channelRef.current) return;
    channelRef.current
      .track({
        user_id: user.id,
        current_path: pathname || "/",
        online_at: new Date().toISOString(),
      })
      .catch(() => {});
  }, [user?.id, pathname]);

  const onlineUsers = useMemo(() => {
    const merged: Record<string, OnlineUserInfo> = { ...serverUsers };
    for (const [uid, rtInfo] of Object.entries(realtimeUsers)) {
      const srvInfo = merged[uid];
      if (!srvInfo || rtInfo.onlineAt >= srvInfo.onlineAt) {
        merged[uid] = {
          ...rtInfo,
          tabCount: Math.max(rtInfo.tabCount, srvInfo?.tabCount ?? 1),
        };
      }
    }
    return merged;
  }, [serverUsers, realtimeUsers]);

  const lastSeenMap = useMemo(() => {
    const merged: Record<string, string> = { ...serverLastSeen };
    for (const [uid, rtTs] of Object.entries(realtimeLastSeen)) {
      if (!merged[uid] || rtTs > merged[uid]) {
        merged[uid] = rtTs;
      }
    }
    return merged;
  }, [serverLastSeen, realtimeLastSeen]);

  const value = useMemo(
    () => ({ onlineUsers, lastSeenMap, connected }),
    [onlineUsers, lastSeenMap, connected],
  );

  return <SitePresenceContext.Provider value={value}>{children}</SitePresenceContext.Provider>;
}

export function useSitePresence() {
  return useContext(SitePresenceContext);
}
