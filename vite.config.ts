// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";

function vite7RolldownBridge() {
  return {
    name: "vite7-rolldown-bridge",
    configEnvironment(_name: string, envConfig: any) {
      const rolldown = envConfig?.build?.rolldownOptions;
      if (rolldown && !envConfig?.build?.rollupOptions?.input) {
        return {
          build: {
            rollupOptions: {
              ...rolldown,
              ...(envConfig.build?.rollupOptions ?? {}),
            },
          },
        };
      }
    },
  };
}

function tanstackClientDefineBridge() {
  const replacements: Array<[RegExp, string]> = [
    [/\bprocess\.env\.TSS_SERVER_FN_BASE\b/g, JSON.stringify("/_serverFn/")],
    [/\bprocess\.env\.TSS_ROUTER_BASEPATH\b/g, JSON.stringify("/")],
    [/\bprocess\.env\.TSS_DEV_SERVER\b/g, JSON.stringify("true")],
    [/\bprocess\.env\.TSS_SHELL\b/g, JSON.stringify("false")],
    [/\bprocess\.env\.TSS_DEV_SSR_STYLES_ENABLED\b/g, JSON.stringify("true")],
    [/\bprocess\.env\.TSS_DEV_SSR_STYLES_BASEPATH\b/g, JSON.stringify("/")],
    [/\bprocess\.env\.TSS_INLINE_CSS_ENABLED\b/g, JSON.stringify("false")],
    [/\bprocess\.env\.TSS_DISABLE_CSRF_MIDDLEWARE_WARNING\b/g, JSON.stringify("false")],
  ];

  return {
    name: "tanstack-client-define-bridge",
    apply: "serve" as const,
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("@tanstack/") || !code.includes("process.env.TSS_")) return null;
      const envName = (this as { environment?: { name?: string } }).environment?.name;
      if (envName && envName !== "client") return null;
      let next = code;
      for (const [pattern, val] of replacements) {
        next = next.replace(pattern, val);
      }
      return next === code ? null : { code: next, map: null };
    },
  };
}

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    optimizeDeps: {
      entries: ["src/router.tsx", "src/routes/**/*.tsx"],
      include: [
        "@supabase/supabase-js",
        "@tanstack/react-query",
        "framer-motion",
        "lucide-react",
        "recharts",
        "lightweight-charts",
        "sonner",
        "date-fns",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
      ],
    },
    plugins: [mcpPlugin(), vite7RolldownBridge(), tanstackClientDefineBridge()],
  },
});
