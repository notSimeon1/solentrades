import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readSitePresenceSnapshot, recordUserHeartbeat, recordUserLeave } from "./presence.server";
import { requireVerifiedAdmin, requireVerifiedUser } from "./server-auth";

const heartbeatSchema = z.object({
  accessToken: z.string().min(1),
  tabId: z.string().min(1).max(120),
  currentPath: z.string().max(300).default("/"),
});

const leaveSchema = z.object({
  accessToken: z.string().min(1),
  tabId: z.string().max(120).default(""),
});

const snapshotSchema = z.object({
  accessToken: z.string().min(1),
});

export const pingUserPresence = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof heartbeatSchema>) => heartbeatSchema.parse(input))
  .handler(async ({ data }) => {
    const caller = await requireVerifiedUser(data.accessToken);
    return recordUserHeartbeat(caller.userId, data.tabId, data.currentPath);
  });

export const leaveUserPresence = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof leaveSchema>) => leaveSchema.parse(input))
  .handler(async ({ data }) => {
    const caller = await requireVerifiedUser(data.accessToken);
    return recordUserLeave(caller.userId, data.tabId);
  });

export const getSitePresenceSnapshot = createServerFn({ method: "POST" })
  .validator((input: z.input<typeof snapshotSchema>) => snapshotSchema.parse(input))
  .handler(async ({ data }) => {
    await requireVerifiedAdmin(data.accessToken);
    return readSitePresenceSnapshot();
  });
