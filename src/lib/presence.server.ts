import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type PresenceTabEntry = {
  currentPath: string;
  lastSeenAt: number;
};

export type StoredUserPresence = {
  tabs: Record<string, PresenceTabEntry>;
  lastSeenAt: number;
};

export type OnlineUserSnapshot = {
  userId: string;
  currentPath: string;
  onlineAt: string;
  tabCount: number;
};

const ONLINE_TTL_MS = 45_000;
const STALE_TAB_CLEANUP_MS = 120_000;
const PRESENCE_KEY_PREFIX = "presence:";

declare global {
  var __solenSitePresenceStore: Map<string, StoredUserPresence> | undefined;
}

function getStore(): Map<string, StoredUserPresence> {
  if (!globalThis.__solenSitePresenceStore) {
    globalThis.__solenSitePresenceStore = new Map<string, StoredUserPresence>();
  }
  return globalThis.__solenSitePresenceStore;
}

function pruneTabs(entry: StoredUserPresence, now: number) {
  for (const [tabId, tab] of Object.entries(entry.tabs)) {
    if (now - tab.lastSeenAt > STALE_TAB_CLEANUP_MS) {
      delete entry.tabs[tabId];
    }
  }
}

async function persistPresenceBestEffort(userId: string, entry: StoredUserPresence) {
  try {
    await supabaseAdmin.from("app_settings").upsert(
      {
        key: `${PRESENCE_KEY_PREFIX}${userId}`,
        value: JSON.stringify(entry),
        updated_at: new Date(entry.lastSeenAt).toISOString(),
      },
      { onConflict: "key" },
    );
  } catch {
    // Non-fatal: in-memory store remains authoritative when RLS/anon fallback prevents DB write
  }
}

export async function recordUserHeartbeat(userId: string, tabId: string, currentPath: string) {
  if (!userId || !tabId) return { ok: false };
  const now = Date.now();
  const store = getStore();
  const existing = store.get(userId) ?? { tabs: {}, lastSeenAt: now };
  pruneTabs(existing, now);

  existing.tabs[tabId] = {
    currentPath: currentPath || "/",
    lastSeenAt: now,
  };
  existing.lastSeenAt = now;
  store.set(userId, existing);

  // Fire-and-forget DB persistence so heartbeats return fast
  void persistPresenceBestEffort(userId, existing);

  return { ok: true, lastSeenAt: now };
}

export async function recordUserLeave(userId: string, tabId: string) {
  if (!userId) return { ok: false };
  const now = Date.now();
  const store = getStore();
  const existing = store.get(userId);
  if (existing) {
    if (tabId) {
      delete existing.tabs[tabId];
    } else {
      existing.tabs = {};
    }
    existing.lastSeenAt = now;
    store.set(userId, existing);
    void persistPresenceBestEffort(userId, existing);
  }
  return { ok: true };
}

export async function readSitePresenceSnapshot(): Promise<{
  onlineUsers: Record<string, OnlineUserSnapshot>;
  lastSeenMap: Record<string, string>;
}> {
  const now = Date.now();
  const store = getStore();

  // Merge any persisted presence rows (useful across serverless workers / cold restarts)
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .like("key", `${PRESENCE_KEY_PREFIX}%`);

    if (Array.isArray(data)) {
      for (const row of data) {
        const userId = String(row.key ?? "").slice(PRESENCE_KEY_PREFIX.length);
        if (!userId) continue;
        try {
          const parsed = JSON.parse(String(row.value ?? "{}")) as StoredUserPresence;
          if (!parsed || typeof parsed !== "object") continue;
          const mem = store.get(userId);
          if (!mem || (parsed.lastSeenAt ?? 0) > mem.lastSeenAt) {
            store.set(userId, {
              tabs: parsed.tabs ?? {},
              lastSeenAt: Number(parsed.lastSeenAt ?? 0),
            });
          }
        } catch {
          // Ignore malformed row
        }
      }
    }
  } catch {
    // Fallback cleanly to in-memory store
  }

  const onlineUsers: Record<string, OnlineUserSnapshot> = {};
  const lastSeenMap: Record<string, string> = {};

  for (const [userId, entry] of store.entries()) {
    pruneTabs(entry, now);
    if (entry.lastSeenAt > 0) {
      lastSeenMap[userId] = new Date(entry.lastSeenAt).toISOString();
    }

    const activeTabs = Object.values(entry.tabs).filter((t) => now - t.lastSeenAt <= ONLINE_TTL_MS);
    if (activeTabs.length > 0) {
      activeTabs.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      const newest = activeTabs[0];
      onlineUsers[userId] = {
        userId,
        currentPath: newest.currentPath || "/",
        onlineAt: new Date(newest.lastSeenAt).toISOString(),
        tabCount: activeTabs.length,
      };
    }
  }

  return { onlineUsers, lastSeenMap };
}
