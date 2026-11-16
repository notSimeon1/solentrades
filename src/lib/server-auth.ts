import { supabaseAdmin } from "@/integrations/supabase/client.server";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ADMIN_EMAILS = [
  "simonosawaru255@gmail.com",
  "bayo@gmail.com",
  "oweanowean24@gmail.com",
];

export const PRIMARY_OWNER_EMAIL = "simonosawaru255@gmail.com";

export type VerifiedCaller = {
  userId: string;
  email: string;
};

/**
 * Cryptographically verifies a Supabase JWT access token on the server.
 * Never trusts client-supplied userIds or unauthenticated fallback strings.
 */
export async function requireVerifiedUser(accessToken?: string | null): Promise<VerifiedCaller> {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) {
    throw new Error("Authentication required. Please sign in again.");
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id || !UUID_REGEX.test(data.user.id)) {
    throw new Error("Invalid or expired session. Please sign in again.");
  }

  return {
    userId: data.user.id,
    email: (data.user.email ?? "").toLowerCase(),
  };
}

/**
 * Verifies that a user ID holds genuine Admin or Super Admin privileges
 * via authorized owner emails, `user_roles`, or `profiles` flags.
 * Rejects empty, missing, or non-UUID identifiers unconditionally.
 */
export async function assertStrictAdmin(userId: string, verifiedEmail?: string): Promise<void> {
  if (!userId || !UUID_REGEX.test(userId)) {
    throw new Error("Admin access requires a valid authenticated account");
  }

  if (verifiedEmail && ADMIN_EMAILS.includes(verifiedEmail.toLowerCase())) {
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (!error && data?.user?.email && ADMIN_EMAILS.includes(data.user.email.toLowerCase())) {
      return;
    }
  } catch {
    // Fallback to DB role checks
  }

  const [{ data: roleRow }, { data: profile }] = await Promise.all([
    supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["admin", "super_admin"] as never)
      .maybeSingle(),
    supabaseAdmin
      .from("profiles")
      .select("is_admin, is_super_admin, role")
      .eq("id", userId)
      .maybeSingle() as unknown as Promise<{
      data: { is_admin?: boolean; is_super_admin?: boolean; role?: string } | null;
    }>,
  ]);

  if (
    roleRow ||
    profile?.is_admin ||
    profile?.is_super_admin ||
    profile?.role === "admin" ||
    profile?.role === "super_admin"
  ) {
    return;
  }

  throw new Error("Admin access is restricted to authorized admin accounts");
}

/**
 * Verifies both JWT session validity and Admin/Super-Admin authorization.
 */
export async function requireVerifiedAdmin(accessToken?: string | null): Promise<VerifiedCaller> {
  const caller = await requireVerifiedUser(accessToken);
  await assertStrictAdmin(caller.userId, caller.email);
  return caller;
}
