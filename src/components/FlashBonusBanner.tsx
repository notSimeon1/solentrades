import React, { useEffect, useState } from "react";
import { Zap, Flame, Clock, Gift, ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { soundFX } from "@/lib/sound-engine";

interface FlashBonusBannerProps {
  onClaim?: (code: string) => void;
  className?: string;
}

export const FlashBonusBanner: React.FC<FlashBonusBannerProps> = ({ onClaim, className = "" }) => {
  // 3-hour flash countdown timer
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number }>({
    hours: 2,
    minutes: 44,
    seconds: 18,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev.seconds > 0) return { ...prev, seconds: prev.seconds - 1 };
        if (prev.minutes > 0) return { ...prev, minutes: 59, seconds: 59 };
        if (prev.hours > 0) return { hours: prev.hours - 1, minutes: 59, seconds: 59 };
        return { hours: 3, minutes: 0, seconds: 0 }; // Reset loop
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleClaim = () => {
    soundFX.playDepositBonus();
    soundFX.triggerHaptic(50);
    if (onClaim) {
      onClaim("FLASH1000");
    }
  };

  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-r from-purple-950 via-slate-900 to-indigo-950 border border-purple-500/40 p-4 sm:p-5 shadow-2xl text-white ${className}`}
    >
      {/* Background glow & accents */}
      <div className="absolute -top-12 -right-12 h-36 w-36 rounded-full bg-purple-500/20 blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 h-36 w-36 rounded-full bg-amber-500/20 blur-2xl pointer-events-none" />

      <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Left: Info */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500 to-yellow-500 px-2.5 py-0.5 text-[10px] font-black text-black tracking-wider shadow-sm uppercase">
              <Flame className="h-3 w-3 fill-black animate-bounce" /> 100% FLASH MATCH BONUS
            </span>
            <span className="text-xs text-purple-300 font-semibold flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-amber-400" /> $1,000+ Tier Unlocked
            </span>
          </div>

          <h3 className="text-lg sm:text-xl font-black tracking-tight text-white">
            Deposit $1,000+ & Get{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-yellow-200 to-emerald-300">
              $1,000 Instant Deposit Bonus!
            </span>
          </h3>

          <p className="text-xs text-slate-300 max-w-lg">
            Boost your margin leverage & tournament rank immediately on deposits of $1,000+.
            Deposits under $1,000 earn Leaderboard Points only.
          </p>

          {/* Progress bar */}
          <div className="pt-1 flex items-center gap-3">
            <div className="flex-1 max-w-xs h-2 rounded-full bg-slate-800 overflow-hidden border border-purple-500/30">
              <div className="h-full w-[84%] bg-gradient-to-r from-amber-500 via-purple-500 to-emerald-400 rounded-full animate-pulse" />
            </div>
            <span className="text-[10px] text-amber-300 font-extrabold uppercase tracking-wider">
              84% Claimed (12 Spots Left)
            </span>
          </div>
        </div>

        {/* Right: Timer & Action */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 shrink-0">
          <div className="bg-slate-950/80 border border-purple-500/30 rounded-xl px-3 py-2 flex items-center gap-2 shadow-inner">
            <Clock className="h-4 w-4 text-amber-400 animate-pulse" />
            <div className="text-center">
              <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">
                Offer Expires In
              </div>
              <div className="font-mono text-sm font-black text-amber-300 tracking-wider">
                {pad(timeLeft.hours)}:{pad(timeLeft.minutes)}:{pad(timeLeft.seconds)}
              </div>
            </div>
          </div>

          <Link
            to="/deposit"
            onClick={handleClaim}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-5 py-3 text-sm font-extrabold text-white shadow-lg shadow-emerald-600/30 hover:from-emerald-400 hover:to-teal-500 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Gift className="h-4 w-4" />
            <span>CLAIM 100% BONUS ($1,000+)</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
