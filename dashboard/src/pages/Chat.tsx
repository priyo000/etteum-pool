import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Send,
  Loader2,
  Plus,
  Trash2,
  Bot,
  User as UserIcon,
  ChevronDown,
} from "lucide-react";
import { API_BASE, getWsBase } from "@/lib/api";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

const STORAGE_KEY = "chat_conversations";

function loadConversations(): ChatConversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveConversations(convs: ChatConversation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m}m lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j lalu`;
  const d = Math.floor(h / 24);
  return `${d}h lalu`;
}

export default function Chat() {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("qd-Qwen3.8-Max-Preview");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentConv = conversations.find((c) => c.id === currentConvId);

  useEffect(() => {
    const convs = loadConversations();
    setConversations(convs);
    if (convs.length > 0) {
      setCurrentConvId(convs[0].id);
      setSelectedModel(convs[0].model);
    }
    fetchModels();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentConv?.messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  async function fetchModels() {
    try {
      const apiKey = localStorage.getItem("api_key") || "pool-proxy-secret-key";
      const res = await fetch(`${API_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        setModels(data.data || []);
      }
    } catch (err) {
      console.error("Failed to fetch models:", err);
    }
  }

  function createNewConversation() {
    const newConv: ChatConversation = {
      id: Date.now().toString(),
      title: "Chat Baru",
      messages: [],
      model: selectedModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const updated = [newConv, ...conversations];
    setConversations(updated);
    saveConversations(updated);
    setCurrentConvId(newConv.id);
    setInput("");
    setError(null);
  }

  function deleteConversation(id: string) {
    const updated = conversations.filter((c) => c.id !== id);
    setConversations(updated);
    saveConversations(updated);
    if (currentConvId === id) {
      setCurrentConvId(updated.length > 0 ? updated[0].id : null);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    let conv = currentConv;
    let updatedConvs = conversations;

    if (!conv) {
      const newConv: ChatConversation = {
        id: Date.now().toString(),
        title: input.slice(0, 50),
        messages: [],
        model: selectedModel,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updatedConvs = [newConv, ...conversations];
      setConversations(updatedConvs);
      setCurrentConvId(newConv.id);
      conv = newConv;
    }

    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    const updatedMessages = [...conv.messages, userMsg];

    updatedConvs = updatedConvs.map((c) =>
      c.id === conv!.id
        ? {
            ...c,
            messages: updatedMessages,
            title: c.messages.length === 0 ? input.slice(0, 50) : c.title,
            updatedAt: Date.now(),
          }
        : c
    );
    setConversations(updatedConvs);
    saveConversations(updatedConvs);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const apiKey = localStorage.getItem("api_key") || "pool-proxy-secret-key";
      const res = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter((line) => line.trim() !== "");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                assistantContent += delta;
                const tempMessages = [...updatedMessages, { role: "assistant" as const, content: assistantContent }];
                updatedConvs = updatedConvs.map((c) =>
                  c.id === conv!.id ? { ...c, messages: tempMessages, updatedAt: Date.now() } : c
                );
                setConversations(updatedConvs);
              }
            } catch (e) {
              console.error("Failed to parse SSE:", e);
            }
          }
        }
      }

      saveConversations(updatedConvs);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setError(errMsg);
      console.error("Chat error:", err);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar - Conversation List */}
      <div className="w-64 flex-shrink-0 bg-[var(--card)] rounded-lg border border-[var(--border)] flex flex-col">
        <div className="p-3 border-b border-[var(--border)]">
          <Button onClick={createNewConversation} className="w-full" size="sm">
            <Plus className="w-4 h-4 mr-2" />
            Chat Baru
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group p-2 rounded cursor-pointer mb-1 transition-colors ${
                currentConvId === conv.id
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "hover:bg-[var(--accent)]/50"
              }`}
              onClick={() => {
                setCurrentConvId(conv.id);
                setSelectedModel(conv.model);
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{conv.title}</div>
                  <div className="text-xs text-[var(--muted-foreground)]">
                    {timeAgo(conv.updatedAt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(conv.id);
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="text-center text-sm text-[var(--muted-foreground)] py-8">
              Belum ada chat
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 bg-[var(--card)] rounded-lg border border-[var(--border)] flex flex-col">
        {/* Header */}
        <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4" />
              {selectedModel}
              <ChevronDown className="w-3 h-3" />
            </Button>
            {showModelDropdown && (
              <div className="absolute top-full left-0 mt-1 w-80 max-h-96 overflow-y-auto bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg z-10">
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="p-2 hover:bg-[var(--accent)] cursor-pointer text-sm"
                    onClick={() => {
                      setSelectedModel(model.id);
                      setShowModelDropdown(false);
                    }}
                  >
                    {model.id}
                  </div>
                ))}
              </div>
            )}
          </div>
          <Badge variant="secondary">{selectedModel}</Badge>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {!currentConv || currentConv.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <MessageSquare className="w-16 h-16 text-[var(--muted-foreground)] mb-4" />
              <h3 className="text-lg font-semibold mb-2">Mulai Chat</h3>
              <p className="text-sm text-[var(--muted-foreground)]">
                Pilih model dan ketik pesan untuk memulai percakapan
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {currentConv.messages.map((msg, idx) => (
                <div key={idx} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 rounded-full bg-[var(--primary)] flex items-center justify-center flex-shrink-0">
                      <Bot className="w-5 h-5 text-[var(--primary-foreground)]" />
                    </div>
                  )}
                  <div
                    className={`max-w-[70%] rounded-lg px-4 py-2 ${
                      msg.role === "user"
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "bg-[var(--accent)] text-[var(--accent-foreground)]"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  </div>
                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center flex-shrink-0">
                      <UserIcon className="w-5 h-5" />
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-[var(--primary)] flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-[var(--primary-foreground)]" />
                  </div>
                  <div className="bg-[var(--accent)] rounded-lg px-4 py-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-3 border-t border-[var(--border)]">
          {error && (
            <div className="mb-2 p-2 bg-[var(--destructive)]/10 text-[var(--destructive)] text-sm rounded">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ketik pesan... (Enter untuk kirim, Shift+Enter untuk baris baru)"
              className="flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              rows={1}
              disabled={loading}
            />
            <Button onClick={sendMessage} disabled={loading || !input.trim()} size="sm">
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
