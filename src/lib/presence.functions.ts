import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readSitePresenceSnapshot, recordUserHeartbeat, recordUserLeave } from "./presence.server";

const heartbeatSchema = z.object({
  userId: z.string().min(1).max(120),
  tabId: z.string().min(1).max(120),
  currentPath: z.string().max(300).default("/"),
});

const leaveSchema = z.object({
  userId: z.string().min(1).max(120),
  tabId: z.string().max(120).default(""),
});

export const pingUserPresence = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof heartbeatSchema>) => heartbeatSchema.parse(input))
  .handler(async ({ data }) => recordUserHeartbeat(data.userId, data.tabId, data.currentPath));

export const leaveUserPresence = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof leaveSchema>) => leaveSchema.parse(input))
  .handler(async ({ data }) => recordUserLeave(data.userId, data.tabId));

export const getSitePresenceSnapshot = createServerFn({ method: "GET" }).handler(async () =>
  readSitePresenceSnapshot(),
);
