import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Eye, EyeOff, RefreshCw, Check, Save, ShieldCheck } from "lucide-react";
import { fetchApiKey, regenerateApiKey, setApiKey, testApiKey } from "@/lib/api";

export default function ApiKey() {
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("api_key") || "pool-proxy-secret-key");
  const [source, setSource] = useState("browser");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);

  function notify(text: string) {
    setMessage(text);
    setError(null);
    setTimeout(() => setMessage(null), 3500);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    setMessage(null);
  }

  function saveToBrowser(key = apiKey) {
    localStorage.setItem("api_key", key);
    setApiKeyState(key);
  }

  async function loadKey() {
    try {
      const res = await fetchApiKey() as { key: string; source: string };
      setApiKeyState(res.key);
      setSource(res.source);
      saveToBrowser(res.key);
      setValid(true);
    } catch (err) {
      fail(err);
    }
  }

  useEffect(() => {
    loadKey();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  async function handleSave() {
    try {
      const res = await setApiKey(apiKey) as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("API key saved to backend and browser. It can now be used for proxy requests.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleRegenerate() {
    if (!confirm("Regenerate API key? Existing generated key will stop working.")) return;
    try {
      const res = await regenerateApiKey() as { key: string; source: string };
      saveToBrowser(res.key);
      setSource(res.source);
      setValid(true);
      notify("New API key generated, saved, and activated.");
    } catch (err) {
      fail(err);
    }
  }

  async function handleTest() {
    try {
      const res = await testApiKey(apiKey) as { valid: boolean };
      setValid(res.valid);
      notify(res.valid ? "API key is valid." : "API key is invalid.");
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">API Key</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Generate and activate proxy API keys
        </p>
      </div>

      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {message || error}
        </div>
      )}

      <Card className="border-[var(--border)] max-w-3xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Active API Key
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono">{source}</span>. The env fallback key also remains accepted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKeyState(e.target.value);
                  setValid(null);
                }}
                className="pr-10 font-mono text-sm"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button variant="outline" size="icon" onClick={handleCopy} title="Copy">
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-sm">
              Status: {valid === true && <span className="text-green-400">valid</span>}
              {valid === false && <span className="text-red-400">invalid</span>}
              {valid === null && <span className="text-[var(--muted-foreground)]">not tested</span>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadKey}>Load Active</Button>
              <Button variant="outline" size="sm" onClick={handleTest}>Test</Button>
              <Button variant="outline" size="sm" onClick={handleRegenerate}>
                <RefreshCw className="w-4 h-4 mr-2" /> Generate
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Save className="w-4 h-4 mr-2" /> Save & Activate
              </Button>
            </div>
          </div>

          <div className="rounded-lg bg-[var(--secondary)] p-4 mt-4">
            <h4 className="text-sm font-medium text-[var(--foreground)] mb-2">Usage Example</h4>
            <pre className="text-xs text-[var(--muted-foreground)] overflow-x-auto">
{`curl http://localhost:1630/v1/chat/completions \\
  -H "Authorization: Bearer ${showKey ? apiKey : "sk-pool-***"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
