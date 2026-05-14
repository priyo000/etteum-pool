import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Globe, Plus, Trash2, Upload, RefreshCw, Power, PowerOff } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ProxyEntry {
  id: number;
  url: string;
  type: string;
  label: string | null;
  status: string;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  errorMessage: string | null;
  successCount: number;
  failCount: number;
  createdAt: string;
}

interface ProxyPoolStatus {
  count: number;
  activeCount: number;
  proxies: ProxyEntry[];
}

export default function ProxyPool() {
  const [pool, setPool] = useState<ProxyPoolStatus>({ count: 0, activeCount: 0, proxies: [] });
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [checking, setChecking] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<ProxyPoolStatus>("/api/proxy-pool/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, activeCount: 0, proxies: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste proxy list first");
      return;
    }

    const proxies = bulkText
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (proxies.length === 0) {
      setMessage("No valid proxies found");
      return;
    }

    try {
      const result = await fetchApi<{ added: number }>("/api/proxy-pool/pool", {
        method: "POST",
        body: JSON.stringify({ proxies }),
      });
      setBulkText("");
      setMessage(`${result.added} proxy added`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to add proxies");
    }
  };

  const handleToggle = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle proxy");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/proxy-pool/pool/${id}`, { method: "DELETE" });
      setMessage("Proxy removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove proxy");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all proxies from pool?")) return;
    try {
      await fetchApi("/api/proxy-pool/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  const handleCheckSingle = async (id: number) => {
    try {
      const result = await fetchApi<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/proxy-pool/pool/${id}/check`,
        { method: "POST" }
      );
      setMessage(result.ok ? `Healthy (${result.latencyMs}ms)` : `Failed: ${result.error}`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Health check failed");
    }
  };

  const handleCheckAll = async () => {
    setChecking(true);
    try {
      const result = await fetchApi<{ checked: number }>("/api/proxy-pool/pool/check-all", {
        method: "POST",
      });
      setMessage(`Checked ${result.checked} proxies`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Check all failed");
    } finally {
      setChecking(false);
    }
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: "bg-green-500/10 text-green-500",
      disabled: "bg-yellow-500/10 text-yellow-500",
      error: "bg-red-500/10 text-red-500",
    };
    return (
      <span className={`text-xs px-2 py-0.5 rounded ${colors[status] || "bg-gray-500/10 text-gray-500"}`}>
        {status}
      </span>
    );
  };

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      const masked = u.password ? `${u.protocol}//${u.username}:***@${u.host}` : `${u.protocol}//${u.host}`;
      return masked;
    } catch {
      return url;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Pool</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Manage HTTP/SOCKS5 proxies for upstream requests and auth
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">
            {pool.activeCount}/{pool.count} active
          </span>
          <Button variant="outline" size="sm" onClick={handleCheckAll} disabled={checking}>
            <RefreshCw className={`w-3 h-3 mr-1 ${checking ? "animate-spin" : ""}`} />
            Check All
          </Button>
          {pool.count > 0 && (
            <Button variant="outline" size="sm" onClick={handleClearAll}>
              <Trash2 className="w-3 h-3 mr-1" />
              Clear All
            </Button>
          )}
        </div>
      </div>

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      {/* Add Proxies */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Add Proxies
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="w-full h-[120px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            placeholder={"Paste proxy list (one per line):\n\nhttp://user:pass@host:port\nsocks5://host:port\nhttp://host:port"}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <Button onClick={handleBulkAdd} className="w-full">
            <Upload className="w-4 h-4 mr-2" />
            Add to Pool
          </Button>
        </CardContent>
      </Card>

      {/* Proxy List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Proxy List
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : pool.proxies.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">
              No proxies in pool. Add proxies above to enable IP rotation.
            </p>
          ) : (
            <div className="space-y-2">
              {pool.proxies.map((proxy) => (
                <div
                  key={proxy.id}
                  className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Globe className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                    <span className="font-mono text-sm truncate">{maskUrl(proxy.url)}</span>
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">{proxy.type}</span>
                    {statusBadge(proxy.status)}
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                      {proxy.successCount}ok / {proxy.failCount}fail
                    </span>
                    {proxy.lastUsedAt && (
                      <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                        used {new Date(proxy.lastUsedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCheckSingle(proxy.id)}
                      title="Health check"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggle(proxy.id, proxy.status)}
                      title={proxy.status === "active" ? "Disable" : "Enable"}
                    >
                      {proxy.status === "active" ? (
                        <PowerOff className="w-3 h-3" />
                      ) : (
                        <Power className="w-3 h-3" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(proxy.id)}
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
