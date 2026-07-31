import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

/**
 * Refresh control for the AUC and MSA tabs.
 *
 * Those pages are served from a disk+memory cache with a one-week freshness
 * window, topped up by a weekly cron. This posts to /aeso/scrape/refresh,
 * which deletes the cached entries, then invalidates the matching React Query
 * keys so the next render re-fetches live from auc.ab.ca / albertamsa.ca.
 *
 * Styled for the dark AUC/MSA header (white/5 on a dark card), which differs
 * from the shadcn tokens used elsewhere in the app.
 */
export function ScrapeRefreshButton({ queryKeys }: { queryKeys: string[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/aeso/scrape/refresh", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      // Cache is cleared server-side; force the client to ask again.
      await Promise.all(queryKeys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      setMsg("Updated");
    } catch {
      setMsg("Refresh failed");
    }
    setBusy(false);
    setTimeout(() => setMsg(null), 4000);
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-white/40">{msg}</span>}
      <button
        onClick={refresh}
        disabled={busy}
        title="Clear the cached copy and re-fetch from the regulator's site"
        className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 transition-colors disabled:opacity-40"
      >
        <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        Refresh
      </button>
    </div>
  );
}
