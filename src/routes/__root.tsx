import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/lib/auth-context";
import { SitePresenceProvider } from "@/lib/presence-context";
import { CurrencyProvider } from "@/lib/currency-context";
import { AccountModeProvider } from "@/lib/account-mode-context";
import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-gradient">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This page doesn't exist on Solen Trades.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  if (
    typeof window !== "undefined" &&
    /Failed to fetch dynamically imported module|Importing a module script failed/i.test(
      error?.message ?? "",
    )
  ) {
    const key = "solen:chunk-reload";
    const last = Number(sessionStorage.getItem(key) || "0");
    if (Date.now() - last > 10000) {
      sessionStorage.setItem(key, String(Date.now()));
      window.location.reload();
      return null;
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">Please try again.</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Solen Trades — Modern Investment Broker" },
      {
        name: "description",
        content:
          "Trade stocks, crypto, and commodities on Solen Trades. Real-time portfolio tracking and a clean, modern broker experience.",
      },
      { property: "og:title", content: "Solen Trades — Modern Investment Broker" },
      {
        property: "og:description",
        content:
          "Trade stocks, crypto, and commodities on Solen Trades. Real-time portfolio tracking and a clean, modern broker experience.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Solen Trades — Modern Investment Broker" },
      {
        name: "twitter:description",
        content:
          "Trade stocks, crypto, and commodities on Solen Trades. Real-time portfolio tracking and a clean, modern broker experience.",
      },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/43464ef5-237a-4c5b-8628-26bd10420b9b",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/43464ef5-237a-4c5b-8628-26bd10420b9b",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Smartsupp Live Chat script (Hidden Widget Mode) */}
        <script
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `var _smartsupp = _smartsupp || {};
_smartsupp.key = '858281b645f5cd6aa90418176b7f9b74b54c7754';
_smartsupp.hideWidget = true;
_smartsupp.hideMobileWidget = true;
window.smartsupp||(function(d) {
  var s,c,o=smartsupp=function(){ o._.push(arguments)};o._=[];
  s=d.getElementsByTagName('script')[0];c=d.createElement('script');
  c.type='text/javascript';c.charset='utf-8';c.async=true;
  c.src='https://www.smartsuppchat.com/loader.js?';s.parentNode.insertBefore(c,s);
})(document);
smartsupp('chat:hide');`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SitePresenceProvider>
          <CurrencyProvider>
            <AccountModeProvider>
              <Outlet />
              <Toaster />
            </AccountModeProvider>
          </CurrencyProvider>
        </SitePresenceProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
