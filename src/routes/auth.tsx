import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Navbar } from "@/components/Navbar";
import { toast } from "sonner";
import { PasswordResetModal } from "@/components/PasswordResetModal";
import { CryptoIcon } from "@/components/CryptoIcon";
import {
  Loader as Loader2,
  TrendingUp,
  ShieldCheck,
  Zap,
  Globe,
  Lock,
  Award,
  Users,
  ChartBar as BarChart3,
  Wallet,
  Bot,
  Headphones,
  Star,
  ArrowUpRight,
  ArrowDownRight,
  KeyRound,
  Sparkles,
  Flame,
  CheckCircle2,
  LogIn,
  UserPlus,
} from "lucide-react";
import { motion } from "framer-motion";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  validateSearch: (s: Record<string, unknown>) => ({
    next:
      typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//")
        ? s.next
        : "",
    tab:
      typeof s.tab === "string" && (s.tab === "signup" || s.tab === "signin")
        ? (s.tab as "signup" | "signin")
        : undefined,
    mode:
      typeof s.mode === "string" && (s.mode === "signup" || s.mode === "signin")
        ? (s.mode as "signup" | "signin")
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in to Solen Trades — Institutional-grade crypto brokerage" },
      {
        name: "description",
        content:
          "Join Solen Trades — a regulated multi-asset brokerage trusted by 180,000+ traders. Trade crypto, stocks and commodities with tight spreads and 24/7 support.",
      },
      { property: "og:title", content: "Solen Trades — Trade smarter, faster, safer" },
      {
        property: "og:description",
        content:
          "Open a Solen Trades account in under 60 seconds and access institutional liquidity, AI trading bots and expert market signals.",
      },
    ],
  }),
});

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(8, "Min 8 characters").max(72),
  fullName: z.string().trim().min(1).max(80).optional(),
});

function AuthPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [tab, setTab] = useState<"signin" | "signup">(
    (search.tab || search.mode) === "signup" ? "signup" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("Australia");
  const [referralCode, setReferralCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastAttempt, setLastAttempt] = useState(0);
  const [resetModalOpen, setResetModalOpen] = useState(false);

  const authCardRef = useRef<HTMLDivElement>(null);

  const returnTo =
    search.next && search.next.startsWith("/") && !search.next.startsWith("//")
      ? search.next
      : "/dashboard";

  // Smooth scroll handler to scroll upwards or downwards right to the auth column
  const scrollToAuth = (targetTab?: "signin" | "signup") => {
    if (targetTab) {
      setTab(targetTab);
    }
    setTimeout(() => {
      if (authCardRef.current) {
        const navOffset = 80;
        const elementPosition = authCardRef.current.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - navOffset;

        window.scrollTo({
          top: Math.max(0, offsetPosition),
          behavior: "smooth",
        });

        // Pulsing highlight effect on the auth card
        authCardRef.current.classList.add("ring-2", "ring-primary", "shadow-glow");
        setTimeout(() => {
          authCardRef.current?.classList.remove("ring-2", "ring-primary", "shadow-glow");
        }, 1200);
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 20);
  };

  // Listen to custom event dispatched by Navbar buttons or elsewhere
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ tab?: "signin" | "signup" }>;
      if (customEvent.detail?.tab) {
        scrollToAuth(customEvent.detail.tab);
      } else {
        scrollToAuth();
      }
    };
    window.addEventListener("auth-scroll-to", handler);
    return () => window.removeEventListener("auth-scroll-to", handler);
  }, []);

  // Update tab if query search param changes
  useEffect(() => {
    const target = search.tab || search.mode;
    if (target === "signup" || target === "signin") {
      setTab(target);
    }
  }, [search.tab, search.mode]);

  useEffect(() => {
    if (!loading && user) {
      if (returnTo === "/dashboard") navigate({ to: "/dashboard" });
      else window.location.href = returnTo;
    }
  }, [user, loading, navigate, returnTo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const now = Date.now();
    if (now - lastAttempt < 3000) {
      toast.error("Please wait a moment before trying again.");
      return;
    }
    setLastAttempt(now);
    setBusy(true);
    try {
      const parsed = schema.safeParse({
        email,
        password,
        fullName: tab === "signup" ? fullName : undefined,
      });
      if (!parsed.success) {
        toast.error(parsed.error.issues[0].message);
        return;
      }
      if (tab === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}${returnTo}`,
            data: { full_name: fullName, country, referral_code: referralCode || undefined },
          },
        });
        if (error) throw error;
        toast.success("Account created. Welcome to Solen Trades.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Welcome back.");
      }
      if (returnTo === "/dashboard") navigate({ to: "/dashboard" });
      else window.location.href = returnTo;
    } catch (err: any) {
      toast.error(err.message ?? "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}${returnTo}`,
        },
      });
      if (error) throw error;
    } catch (err: any) {
      toast.error(err.message ?? "Google Sign-In failed");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Navbar />

      {/* HERO + AUTH FORM (split screen) */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/10 via-transparent to-accent/10" />
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-6 py-14 lg:grid-cols-[1.15fr_0.85fr] lg:py-20">
          {/* LEFT: pitch */}
          <div className="flex flex-col justify-center">
            <Badge
              variant="outline"
              className="mb-4 w-fit border-primary/40 bg-primary/5 text-primary"
            >
              <ShieldCheck className="mr-1.5 h-3 w-3" /> Regulated · SOC 2 Type II · Cold-storage
              custody
            </Badge>
            <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Trade the world's markets
              <br />
              <span className="bg-gradient-hero bg-clip-text text-transparent">
                with institutional edge.
              </span>
            </h1>
            <p className="mt-4 max-w-xl text-base text-muted-foreground">
              Solen Trades gives retail traders the same execution stack the pros use — deep
              liquidity, AI-driven signals, copy trading and 24/7 desk support. Open an account in
              under 60 seconds.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <span className="font-semibold">180,000+</span>
                <span className="text-muted-foreground">active traders</span>
              </div>
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                <span className="font-semibold">$4.2B+</span>
                <span className="text-muted-foreground">monthly volume</span>
              </div>
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary" />
                <span className="font-semibold">140+</span>
                <span className="text-muted-foreground">countries</span>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                className="bg-gradient-hero font-bold shadow-glow"
                onClick={() => scrollToAuth("signup")}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Create Free Account
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="font-semibold"
                onClick={() => scrollToAuth("signin")}
              >
                <LogIn className="mr-2 h-4 w-4" />
                Sign In
              </Button>
            </div>
          </div>

          {/* RIGHT: auth card */}
          <div
            ref={authCardRef}
            id="auth-column"
            className="w-full transition-all duration-300 rounded-2xl"
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-hero shadow-glow">
                <TrendingUp className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Welcome to Solen Trades</h2>
                <p className="text-xs text-muted-foreground">
                  Sign in or create your trading account.
                </p>
              </div>
            </div>
            <div className="w-full rounded-2xl border border-border bg-gradient-card p-6 shadow-elegant">
              <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="signin">Sign in</TabsTrigger>
                  <TabsTrigger value="signup">Create account</TabsTrigger>
                </TabsList>

                <div className="mt-6 space-y-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex w-full items-center justify-center gap-2 border-border bg-background/80 py-2.5 font-medium hover:bg-muted"
                    onClick={handleGoogleSignIn}
                    disabled={busy}
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>{tab === "signup" ? "Sign up with Google" : "Continue with Google"}</span>
                  </Button>

                  <div className="relative flex items-center justify-center">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-border" />
                    </div>
                    <span className="relative bg-surface px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                      Or with email
                    </span>
                  </div>

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <TabsContent value="signup" className="m-0 space-y-4">
                      <div>
                        <Label htmlFor="name">Full name</Label>
                        <Input
                          id="name"
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          placeholder="Ada Lovelace"
                          required={tab === "signup"}
                          maxLength={80}
                        />
                      </div>
                      <div>
                        <Label htmlFor="country">Country</Label>
                        <Input
                          id="country"
                          value={country}
                          onChange={(e) => setCountry(e.target.value)}
                          placeholder="Australia"
                          required={tab === "signup"}
                          maxLength={80}
                        />
                      </div>
                      <div>
                        <Label htmlFor="referral">Referral code (optional)</Label>
                        <Input
                          id="referral"
                          value={referralCode}
                          onChange={(e) => setReferralCode(e.target.value)}
                          placeholder="Enter referrer's code (optional)"
                          maxLength={40}
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Optional. Any code entered is accepted automatically without restricting
                          account creation.
                        </p>
                      </div>
                    </TabsContent>
                    <div>
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@solentrades.com"
                        required
                        maxLength={255}
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">Password</Label>
                        {tab === "signin" && (
                          <button
                            type="button"
                            onClick={() => setResetModalOpen(true)}
                            className="text-xs font-medium text-primary hover:underline flex items-center gap-1"
                          >
                            <KeyRound className="h-3 w-3" />
                            Forgot Password?
                          </button>
                        )}
                      </div>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        minLength={8}
                        maxLength={72}
                      />
                    </div>
                    <Button type="submit" className="w-full bg-gradient-hero" disabled={busy}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {tab === "signup" ? "Create free account" : "Sign in securely"}
                    </Button>
                    <p className="text-center text-[11px] text-muted-foreground">
                      <Lock className="inline h-3 w-3 mr-1" />
                      256-bit encryption · 2FA enforced · Funds held 1:1
                    </p>
                  </form>

                  {/* Switcher links */}
                  <div className="pt-2 text-center text-xs text-muted-foreground border-t border-border/50">
                    {tab === "signup" ? (
                      <span>
                        Already have an account?{" "}
                        <button
                          type="button"
                          onClick={() => scrollToAuth("signin")}
                          className="font-semibold text-primary hover:underline"
                        >
                          Sign in here
                        </button>
                      </span>
                    ) : (
                      <span>
                        Don't have an account?{" "}
                        <button
                          type="button"
                          onClick={() => scrollToAuth("signup")}
                          className="font-semibold text-primary hover:underline"
                        >
                          Create account for free
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              </Tabs>
            </div>
            <p className="mt-4 text-center text-[11px] text-muted-foreground">
              By continuing you agree to Solen Trades's{" "}
              <Link to="/support" className="underline">
                terms &amp; risk policy
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      <PasswordResetModal
        open={resetModalOpen}
        onOpenChange={setResetModalOpen}
        defaultEmail={email}
      />

      {/* XRP INSTITUTIONAL SPOTLIGHT & "XRP IS THE NEW BITCOIN" */}
      <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-sky-500/10 via-background to-background py-16 px-6">
        <div className="mx-auto max-w-7xl">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-7 space-y-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3.5 py-1 text-xs font-semibold text-sky-400">
                <Flame className="h-3.5 w-3.5 text-amber-400 animate-pulse" />
                <span>Next-Gen Global Liquidity</span>
              </div>
              <div className="space-y-3">
                <blockquote className="text-3xl font-black tracking-tight sm:text-4xl lg:text-5xl text-foreground">
                  “
                  <span className="bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-400 bg-clip-text text-transparent">
                    XRP is the new bitcoin
                  </span>
                  ”
                </blockquote>
                <p className="text-base text-muted-foreground leading-relaxed max-w-2xl">
                  While legacy assets take minutes and charge heavy fees, XRP settles in 3–5 seconds
                  with fractions of a cent in cost. Wall Street liquidity providers and global
                  banking giants are adopting the XRP Ledger for instant trillions in cross-border
                  volume — propelling XRP into an institutional supercycle targeting{" "}
                  <strong>$50+ and beyond</strong>.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2">
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3.5">
                  <div className="text-xs text-muted-foreground font-medium">Settlement Speed</div>
                  <div className="text-xl font-bold text-sky-400 mt-1">3–5 Sec</div>
                  <div className="text-[11px] text-muted-foreground">vs 10+ min on BTC</div>
                </div>
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3.5">
                  <div className="text-xs text-muted-foreground font-medium">Throughput</div>
                  <div className="text-xl font-bold text-emerald-400 mt-1">1,500+ TPS</div>
                  <div className="text-[11px] text-muted-foreground">Scalable to Visa-grade</div>
                </div>
                <div className="col-span-2 sm:col-span-1 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3.5">
                  <div className="text-xs text-muted-foreground font-medium">
                    Analyst Moon Target
                  </div>
                  <div className="text-xl font-bold text-amber-400 mt-1">$50.00+</div>
                  <div className="text-[11px] text-muted-foreground">Institutional Target</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button
                  size="lg"
                  className="bg-sky-500 hover:bg-sky-600 text-white font-bold shadow-lg shadow-sky-500/25"
                  onClick={() => scrollToAuth("signup")}
                >
                  <Sparkles className="mr-2 h-4 w-4" /> Start Trading XRP Now
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
                  onClick={() => scrollToAuth("signin")}
                >
                  <LogIn className="mr-2 h-4 w-4" /> Sign In to Trade
                </Button>
                <Link
                  to="/trade"
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-border text-sm font-semibold hover:bg-muted transition-colors"
                >
                  <CryptoIcon symbol="XRP" size="xs" /> View Live XRP Chart
                </Link>
              </div>
            </div>

            <div className="lg:col-span-5">
              <Card className="border-sky-500/30 bg-gradient-to-br from-card to-sky-950/20 p-6 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                  <CryptoIcon symbol="XRP" size="xl" className="h-44 w-44" />
                </div>
                <div className="flex items-center gap-3 pb-4 border-b border-border/70">
                  <CryptoIcon symbol="XRP" size="md" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-base">XRP / USDT</span>
                      <Badge className="bg-sky-500/20 text-sky-400 border-sky-500/40 text-[10px]">
                        HOT TREND
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Ripple Ledger Native Asset
                    </span>
                  </div>
                </div>

                <div className="space-y-3 py-4 text-xs">
                  <div className="flex justify-between items-center py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Network Architecture</span>
                    <span className="font-medium text-foreground">XRPL Consensus Protocol</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Average Gas Fee</span>
                    <span className="font-medium text-emerald-400">~$0.0002 / tx</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Institutional Custody</span>
                    <span className="font-medium text-foreground">Multi-Sig Cold Storage</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-border/40">
                    <span className="text-muted-foreground">Moonshot Forecast</span>
                    <span className="font-bold text-amber-400">$50.00 – $100.00+</span>
                  </div>
                </div>

                <div className="rounded-lg bg-sky-500/10 border border-sky-500/20 p-3 text-[11px] text-sky-300">
                  🚀 <strong>Trading Floor Note:</strong> High institutional accumulation detected
                  on XRPL corridors. Instant deposit and instant cash-out supported on Solen Trades.
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* WHY CHOOSE SOLEN TRADES */}
      <section className="border-b border-border bg-surface/30">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <div className="mb-10 flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
            <div>
              <Badge variant="outline" className="mb-3 border-primary/40 text-primary">
                Why Solen Trades
              </Badge>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Built for traders who don't compromise.
              </h2>
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Every layer of the platform — from custody to execution to support — is engineered to
              match what an institutional trading desk demands.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {WHY_ITEMS.map((it, i) => (
              <motion.div
                key={it.title}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ delay: i * 0.05 }}
              >
                <Card className="h-full border-border/70 bg-surface p-6 transition-colors hover:border-primary/40">
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <it.icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-base font-semibold">{it.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{it.body}</p>
                </Card>
              </motion.div>
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/10 via-card to-background p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h4 className="text-base font-bold text-foreground">
                Experience institutional execution in 60 seconds
              </h4>
              <p className="text-xs text-muted-foreground">
                Zero deposit fees · Instant crypto &amp; fiat funding · 24/7 desk support
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Button
                className="bg-gradient-hero font-semibold shadow-glow"
                onClick={() => scrollToAuth("signup")}
              >
                <UserPlus className="mr-1.5 h-4 w-4" /> Open Account
              </Button>
              <Button variant="outline" onClick={() => scrollToAuth("signin")}>
                <LogIn className="mr-1.5 h-4 w-4" /> Sign In
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* MARKET INSIGHTS */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <div className="mb-8 flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4">
            <div>
              <Badge variant="outline" className="mb-3 border-primary/40 text-primary">
                Live desk · Delayed 15m
              </Badge>
              <h2 className="text-3xl font-bold tracking-tight">
                Market insights, curated by our desk.
              </h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                What the Solen Trades trading floor is watching this session — signed in traders see
                the full stream in real time.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => scrollToAuth("signin")}>
                <LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign In for Live Desk
              </Button>
              <Button
                size="sm"
                className="bg-gradient-hero font-semibold"
                onClick={() => scrollToAuth("signup")}
              >
                <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Join Free
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MARKET_ROWS.map((m) => (
              <Card key={m.pair} className="border-border/70 bg-surface p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{m.pair}</span>
                  <Badge
                    variant={m.change > 0 ? "default" : "destructive"}
                    className={m.change > 0 ? "bg-success text-success-foreground" : ""}
                  >
                    {m.change > 0 ? (
                      <ArrowUpRight className="mr-1 h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="mr-1 h-3 w-3" />
                    )}
                    {m.change > 0 ? "+" : ""}
                    {m.change.toFixed(2)}%
                  </Badge>
                </div>
                <div className="mt-2 text-xs font-medium leading-relaxed text-foreground/90">
                  {m.price}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{m.note}</div>
              </Card>
            ))}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            {INSIGHTS.map((n) => (
              <Card key={n.title} className="border-border/70 bg-surface p-5">
                <Badge variant="outline" className="mb-2 text-[10px] uppercase tracking-wider">
                  {n.tag}
                </Badge>
                <h3 className="text-sm font-semibold leading-snug">{n.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{n.body}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="border-b border-border bg-surface/30">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <div className="mb-10 text-center">
            <Badge variant="outline" className="mb-3 border-primary/40 text-primary">
              Traders talk
            </Badge>
            <h2 className="text-3xl font-bold tracking-tight">
              Rated 4.8 / 5 by verified traders.
            </h2>
            <div className="mt-3 flex justify-center gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star key={s} className="h-5 w-5 fill-primary text-primary" />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <Card key={t.name} className="border-border/70 bg-surface p-6">
                <div className="mb-3 flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star key={s} className="h-3.5 w-3.5 fill-primary text-primary" />
                  ))}
                </div>
                <p className="text-sm leading-relaxed">"{t.quote}"</p>
                <div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white border border-blue-400/40">
                    {t.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.role}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap justify-center items-center gap-3">
            <Button
              size="lg"
              className="bg-gradient-hero font-bold shadow-glow"
              onClick={() => scrollToAuth("signup")}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Join 180,000+ Traders — Sign Up Free
            </Button>
            <Button size="lg" variant="outline" onClick={() => scrollToAuth("signin")}>
              <LogIn className="mr-2 h-4 w-4" />
              Sign In to Portal
            </Button>
          </div>
        </div>
      </section>

      {/* FOOTER STRIP */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-7xl px-6 py-12 text-center">
          <h3 className="text-2xl font-bold">Ready to trade with an edge?</h3>
          <p className="mt-2 text-sm text-muted-foreground max-w-lg mx-auto">
            Open your Solen Trades account today — no minimum deposit to explore the platform.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              className="bg-gradient-hero font-bold shadow-glow"
              onClick={() => scrollToAuth("signup")}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Create free account
            </Button>
            <Button size="lg" variant="outline" onClick={() => scrollToAuth("signin")}>
              <LogIn className="mr-2 h-4 w-4" />
              Sign in to existing account
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

const WHY_ITEMS = [
  {
    icon: ShieldCheck,
    title: "Regulated custody",
    body: "95% of client crypto is held in insured, geographically-distributed cold storage. Fiat sits in segregated tier-1 bank accounts.",
  },
  {
    icon: Zap,
    title: "Institutional execution",
    body: "Aggregated liquidity from Binance, Coinbase Prime and OKX. Median fill latency under 40 ms with anti-slippage routing.",
  },
  {
    icon: Bot,
    title: "AI trading bots",
    body: "Deploy strategies audited by our quant desk. Multi-indicator signals, risk-managed sizing and daily automated compounding.",
  },
  {
    icon: BarChart3,
    title: "Pro-grade charts",
    body: "TradingView-powered charts with 100+ indicators, drawing tools, alerts and multi-timeframe analytics on every instrument.",
  },
  {
    icon: Wallet,
    title: "Multi-asset wallet",
    body: "One account for BTC, ETH, USDT, majors, blue-chip equities, indices and commodities. Instant internal transfers.",
  },
  {
    icon: Headphones,
    title: "24/7 human support",
    body: "Live desk chat with a real trader — never a bot maze. Average response time under 90 seconds, day or night.",
  },
  {
    icon: Award,
    title: "Copy the top desks",
    body: "Mirror verified strategists with transparent track records. One-tap allocation, one-tap exit, no lock-ups.",
  },
  {
    icon: Lock,
    title: "Security by design",
    body: "Hardware-key 2FA, withdrawal allow-listing, per-device sessions and always-on withdrawal delay for cold accounts.",
  },
  {
    icon: Globe,
    title: "Globally available",
    body: "Onboard in 140+ countries. Deposit via XRP (XRPL), bank wire, card, USDT (TRC20/BEP20), BTC and ETH.",
  },
];

const MARKET_ROWS = [
  {
    pair: "XRP / USDT",
    price: "Next-gen global interbank liquidity standard on the high-speed XRP Ledger.",
    change: 14.85,
    note: "“XRP is the new bitcoin” — targeting $50+ moonshot",
  },
  {
    pair: "BTC / USDT",
    price: "Bitcoin operates on a decentralized, permissionless blockchain using PoW.",
    change: 2.14,
    note: "Consolidating near institutional liquidity zones",
  },
  {
    pair: "ETH / USDT",
    price: "Ethereum introduced smart contracts and is the foundation for DeFi and NFTs.",
    change: 1.62,
    note: "ETF inflows accelerating",
  },
  {
    pair: "SOL / USDT",
    price: "Solana uses PoH and PoS to achieve high transaction throughput and low fees.",
    change: 3.84,
    note: "High retail & DEX volume expansion",
  },
];

const INSIGHTS = [
  {
    tag: "XRP Focus",
    title: "'XRP is the new bitcoin' — Global banking rails accelerate XRPL liquidity",
    body: "Institutional desks forecast a parabolic expansion above $50 as trillions in cross-border settlements transition to instant XRPL liquidity corridors.",
  },
  {
    tag: "Crypto",
    title: "XRP & Altcoin rotation sparks supercycle momentum",
    body: "Desk analysis: capital velocity is shifting decisively toward real utility assets with instant finality. XRP leading volume across global OTC desks.",
  },
  {
    tag: "Signals",
    title: "High-conviction XRP long signal issued on Solen Trades desk",
    body: "Subscribers gained 84% on the last swing. Multi-target alerts for XRP breakout above historical resistance are now active.",
  },
];

const TESTIMONIALS = [
  {
    name: "Marcus Chen",
    role: "Prop desk trader · Singapore",
    quote:
      "Solen Trades is the first retail broker whose execution I actually trust. Fills are clean, spreads are institutional and the AI bots earn while I sleep.",
  },
  {
    name: "Aisha Okafor",
    role: "Full-time swing trader · Lagos",
    quote:
      "I moved my entire portfolio from three exchanges to Solen Trades. One dashboard, one wallet, one support desk that actually answers.",
  },
  {
    name: "Daniel Rodríguez",
    role: "Copy-trading investor · Madrid",
    quote:
      "Copied a top strategist for 4 months and pulled 62% return. The transparency on drawdowns and open positions is unmatched.",
  },
];
