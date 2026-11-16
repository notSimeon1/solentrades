import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const submitKycSchema = z.object({
  accessToken: z.string().min(1),
  userId: z.string().uuid(),
  fullName: z.string().min(1).max(120),
  dateOfBirth: z.string().nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  documentType: z.string().min(1).max(40),
  documentUrl: z.string().min(1),
});

export const submitKycApplication = createServerFn({ method: "POST" })
  .validator((input) => submitKycSchema.parse(input))
  .handler(async ({ data }) => {
    const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(data.accessToken);
    if (authErr || !userRes?.user || userRes.user.id !== data.userId) {
      throw new Error("Session expired. Please sign out and sign in again.");
    }

    const uid = userRes.user.id;
    let finalDocUrl = data.documentUrl;

    // If client sent a base64 data URL because storage RLS blocked direct upload,
    // try uploading via supabaseAdmin into kyc-documents first
    if (data.documentUrl.startsWith("data:")) {
      try {
        const match = data.documentUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const mime = match[1];
          const b64 = match[2];
          const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
          const path = `${uid}/${Date.now()}.${ext}`;
          const buf = Buffer.from(b64, "base64");
          const { error: upErr } = await supabaseAdmin.storage
            .from("kyc-documents")
            .upload(path, buf, { upsert: true, contentType: mime });
          if (!upErr) {
            finalDocUrl = path;
          }
        }
      } catch {
        // Keep base64 data URL as fallback
      }
    }

    const { error: insertErr } = await supabaseAdmin.from("kyc_submissions").insert({
      user_id: uid,
      full_name: data.fullName.trim(),
      date_of_birth: data.dateOfBirth || null,
      country: data.country?.trim() || "Australia",
      document_type: data.documentType,
      document_url: finalDocUrl,
    });

    if (insertErr) {
      throw new Error(insertErr.message);
    }

    await supabaseAdmin
      .from("profiles")
      .update({ kyc_status: "pending", updated_at: new Date().toISOString() })
      .eq("id", uid)
      .in("kyc_status", ["none", "rejected"]);

    return { ok: true };
  });
