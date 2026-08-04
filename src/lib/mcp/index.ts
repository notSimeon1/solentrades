import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getMyProfile from "./tools/get-my-profile";
import listMyTransactions from "./tools/list-my-transactions";
import listMyPositions from "./tools/list-my-positions";
import listMyDeposits from "./tools/list-my-deposits";
import listMyWithdrawals from "./tools/list-my-withdrawals";
import listMarketNews from "./tools/list-market-news";

// Direct Supabase issuer required (not the .lovable.cloud proxy).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "frobex-mcp",
  title: "Frobex",
  version: "0.1.0",
  instructions:
    "Frobex is an investment/trading app. These tools read the signed-in user's own account: profile, balances, transactions, open positions, deposits, withdrawals, and market news. All calls run as that user with row-level security enforced.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    getMyProfile,
    listMyTransactions,
    listMyPositions,
    listMyDeposits,
    listMyWithdrawals,
    listMarketNews,
  ],
});
