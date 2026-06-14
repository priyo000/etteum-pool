import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Globe, Power, PowerOff, Copy, ExternalLink, Loader2,
  Cloud, Server, CheckCircle2, XCircle, RefreshCw,
} from "lucide-react";
import {
  fetchTunnelStatus,
  enableTunnel,
  disableTunnel,
  fetchTunnelDeployUrls,
  saveEdgeRelay,
  deleteEdgeRelay,
} from "@/lib/api";

export default function Relay() {
  const [status, setStatus] = useState<any>(null);
  const [deployUrls, setDeployUrls] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [edgeUrl, setEdgeUrl] = useState("");
  const [edgePlatform, setEdgePlatform] = useState("vercel");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const s = await fetchTunnelStatus();
      setStatus(s);
      if (s.tunnelUrl) {
        const d = await fetchTunnelDeployUrls();
        setDeployUrls(d);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => { refresh(); }, []);

  const handleEnable = async () => {
    setEnabling(true);
    setError("");
    try {
      const res = await enableTunnel();
      if (res.success) {
        await refresh();
      } else {
        setError(res.error || "Failed to enable tunnel");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setEnabling(false);
    }
  };

  const handleDisable = async () => {
    setLoading(true);
    try {
      await disableTunnel();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEdge = async () => {
    if (!edgeUrl) return;
    try {
      await saveEdgeRelay({ platform: edgePlatform, url: edgeUrl });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDeleteEdge = async () => {
    try {
      await deleteEdgeRelay();
      setEdgeUrl("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="h-6 w-6" /> Relay & Tunnel
        </h1>
        <p className="text-muted-foreground mt-1">
          Expose your pool to the internet. One-click tunnel + deploy edge relay.
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => setError("")}>×</Button>
        </div>
      )}

      {/* Cloudflared Tunnel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Cloudflare Tunnel
          </CardTitle>
          <CardDescription>
            Expose your local pool via Cloudflare Quick Tunnel (free, no account needed)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Status */}
          <div className="flex items-center gap-3">
            <div className={`h-3 w-3 rounded-full ${status?.running ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
            <span className="font-medium">
              {status?.running ? "Running" : status?.enabled ? "Starting..." : "Disabled"}
            </span>
            <Button variant="ghost" size="sm" onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {/* Tunnel URL */}
          {status?.tunnelUrl && (
            <div className="flex items-center gap-2 bg-muted rounded-lg p-3">
              <code className="text-sm flex-1 break-all">{status.tunnelUrl}</code>
              <Button
                variant="ghost" size="sm"
                onClick={() => copyToClipboard(status.tunnelUrl, "tunnel")}
              >
                {copied === "tunnel" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={status.tunnelUrl} target="_blank" rel="noopener">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          )}

          {/* Download progress */}
          {status?.download?.downloading && (
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Downloading cloudflared... {status.download.progress}%</div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${status.download.progress}%` }} />
              </div>
            </div>
          )}

          {/* Enable/Disable */}
          <div className="flex gap-2">
            {!status?.running ? (
              <Button onClick={handleEnable} disabled={enabling}>
                {enabling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Power className="h-4 w-4 mr-2" />}
                {enabling ? "Starting tunnel..." : "Enable Tunnel"}
              </Button>
            ) : (
              <Button variant="destructive" onClick={handleDisable} disabled={loading}>
                <PowerOff className="h-4 w-4 mr-2" />
                Disable Tunnel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edge Relay Deploy */}
      {status?.tunnelUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5" />
              Edge Relay (Stable URL)
            </CardTitle>
            <CardDescription>
              Deploy a free edge relay for a stable URL that never changes, even when tunnel restarts.
              Click a button below to deploy.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* One-click deploy buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <a
                href={deployUrls?.deployUrls?.vercel || "#"}
                target="_blank"
                rel="noopener"
                className="block"
              >
                <Button variant="outline" className="w-full justify-start gap-2">
                  <svg className="h-4 w-4" viewBox="0 0 76 65" fill="currentColor"><path d="M37.5274 0L75.0548 65H0L37.5274 0Z"/></svg>
                  Deploy to Vercel
                  <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                </Button>
              </a>
              <a
                href={deployUrls?.deployUrls?.deno || "#"}
                target="_blank"
                rel="noopener"
                className="block"
              >
                <Button variant="outline" className="w-full justify-start gap-2">
                  <span className="font-bold text-sm">🦕</span>
                  Deploy to Deno
                  <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                </Button>
              </a>
              <a
                href={deployUrls?.deployUrls?.cloudflareWorkers || "#"}
                target="_blank"
                rel="noopener"
                className="block"
              >
                <Button variant="outline" className="w-full justify-start gap-2">
                  <span className="font-bold text-sm">⚡</span>
                  Deploy to CF Workers
                  <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
                </Button>
              </a>
            </div>

            <div className="text-xs text-muted-foreground">
              POOL_URL will be pre-filled with: <code>{status.tunnelUrl}</code>
            </div>

            {/* Save deployed edge URL */}
            <div className="border-t pt-4 space-y-3">
              <p className="text-sm font-medium">After deploying, save your edge relay URL here:</p>
              <div className="flex gap-2">
                <select
                  className="border rounded-md px-3 py-2 text-sm bg-background"
                  value={edgePlatform}
                  onChange={(e) => setEdgePlatform(e.target.value)}
                >
                  <option value="vercel">Vercel</option>
                  <option value="deno">Deno Deploy</option>
                  <option value="cloudflare">CF Workers</option>
                </select>
                <Input
                  placeholder="https://your-relay.vercel.app"
                  value={edgeUrl}
                  onChange={(e) => setEdgeUrl(e.target.value)}
                  className="flex-1"
                />
                <Button onClick={handleSaveEdge} disabled={!edgeUrl}>Save</Button>
              </div>
            </div>

            {/* Saved edge relay */}
            {status?.edge?.url && (
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Edge relay active ({status.edge.platform})
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-sm flex-1 break-all">{status.edge.url}/v1</code>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => copyToClipboard(`${status.edge.url}/v1`, "edge")}
                  >
                    {copied === "edge" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Point Cursor/CLI to this URL. API key same as your pool key.
                </p>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDeleteEdge}>
                  <XCircle className="h-3 w-3 mr-1" /> Remove
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Usage Guide */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Setup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
            <li><strong>Enable Tunnel</strong> — click the button above to get a public URL</li>
            <li><strong>Deploy Edge Relay</strong> — click "Deploy to Vercel/Deno/CF" for a stable URL</li>
            <li><strong>Configure your AI tool:</strong></li>
          </ol>
          <div className="bg-muted rounded-lg p-3 font-mono text-xs space-y-1">
            <div>Base URL: <span className="text-primary">{status?.edge?.url || status?.tunnelUrl || "https://your-relay.vercel.app"}/v1</span></div>
            <div>API Key: <span className="text-primary">your-pool-api-key</span></div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
