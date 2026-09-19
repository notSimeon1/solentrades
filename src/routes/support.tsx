import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Navbar } from "@/components/Navbar";
import { WhatsAppChat } from "@/components/WhatsAppChat";
import { getOrCreateUserSupportThread } from "@/lib/support-service";

export const Route = createFileRoute("/support")({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: "Support Live Chat — Solen Trades" },
      { name: "description", content: "Chat live with Solen Trades customer support." },
      { property: "og:title", content: "Support Live Chat — Solen Trades" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function SupportPage() {
  const { user } = useAuth();
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let isMounted = true;
    (async () => {
      const name = user.user_metadata?.full_name || user.email?.split("@")[0];
      const thread = await getOrCreateUserSupportThread(user.id, name);
      if (isMounted && thread) {
        setThreadId(thread.id);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [user]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      <main className="flex flex-1 flex-col mx-auto w-full max-w-4xl px-4 py-6">
        {!user ? (
          <div className="rounded-2xl border border-border bg-card p-12 text-center shadow-elegant">
            <h2 className="text-xl font-bold">Sign in for Live Chat</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Log in to connect with live support agents in real-time.
            </p>
          </div>
        ) : !threadId ? (
          <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">
            Connecting to support server...
          </div>
        ) : (
          <WhatsAppChat
            threadId={threadId}
            userId={user.id}
            currentUserRole="user"
            recipientName="Solen Trades Customer Support"
            recipientStatus="Online • Replies instantly"
            height="h-[700px]"
          />
        )}
      </main>
    </div>
  );
}
