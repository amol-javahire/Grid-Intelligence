import { useState, useRef, useEffect } from "react";
import { CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, BrainCircuit, Zap, Loader2, Database, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Message {
  role: "user" | "assistant";
  content: string;
  sqlQueries?: string[];
}

const SUGGESTED = [
  "What are our top 3 ERCOT wind candidates by overall score?",
  "Which ERCOT nodes have the highest negative price frequency?",
  "Compare curtailment risk: ERCOT LZ_WEST vs LZ_HOUSTON for wind",
  "What is the queue depth for solar in CAISO by status?",
];

export default function QACopilot() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "I'm the Grid Origination Copilot, connected to live market data across ERCOT, CAISO, and PJM. I can query the database directly to answer questions about candidates, nodal pricing, congestion risk, curtailment exposure, and interconnection queue dynamics.\n\nTry asking about specific candidates, node spreads, or market comparisons.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sqlStatus, setSqlStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sqlStatus]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setSqlStatus(null);

    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      const sqlQueryLog: string[] = [];

      setMessages(prev => [...prev, { role: "assistant", content: "", sqlQueries: [] }]);

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (data.type === "sql_query" && typeof data.rationale === "string") {
                setSqlStatus(data.rationale);
                sqlQueryLog.push(data.rationale);
              } else if (data.type === "sql_done" || data.type === "sql_error") {
                setSqlStatus(null);
              } else if (data.content) {
                assistantContent += data.content as string;
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantContent,
                    sqlQueries: sqlQueryLog.length > 0 ? [...sqlQueryLog] : undefined,
                  };
                  return updated;
                });
              } else if (data.error) {
                assistantContent = String(data.error);
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { role: "assistant", content: assistantContent };
                  return updated;
                });
              }
            } catch {}
          }
        }
      }
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error connecting to the AI backend. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
      setSqlStatus(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="p-8 h-full flex flex-col items-center">
      <div className="w-full max-w-4xl h-full flex flex-col gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <div className="p-2 bg-primary/20 rounded-md">
            <BrainCircuit className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Origination Copilot</h1>
            <p className="text-muted-foreground">
              Natural language interface powered by OpenAI + live market data.
            </p>
          </div>
          <Badge
            variant="outline"
            className="ml-auto bg-card"
            style={{ color: "#22c55e", borderColor: "rgba(34,197,94,0.3)" }}
          >
            <Zap className="mr-1 h-3 w-3" style={{ color: "#22c55e" }} /> OpenAI + Live DB
          </Badge>
        </div>

        {messages.length === 1 && (
          <div className="grid grid-cols-2 gap-2 shrink-0">
            {SUGGESTED.map((s, i) => (
              <button
                key={i}
                onClick={() => sendMessage(s)}
                className="text-left text-sm p-3 rounded-lg border border-border bg-card hover:border-primary/50 hover:bg-primary/5 transition-all text-muted-foreground hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 border border-border rounded-xl bg-card/50 overflow-hidden flex flex-col min-h-0">
          <ScrollArea className="flex-1 p-6">
            <div className="space-y-5">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                  <div
                    className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary border border-border"
                    }`}
                  >
                    {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                  </div>
                  <div
                    className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[82%] gap-1`}
                  >
                    {msg.role === "assistant" && msg.sqlQueries && msg.sqlQueries.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {msg.sqlQueries.map((q, qi) => (
                          <span
                            key={qi}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                          >
                            <Database className="h-3 w-3" />
                            {q}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-tr-sm"
                          : "bg-card border shadow-sm rounded-tl-sm"
                      }`}
                    >
                      {msg.content === "" && isLoading && i === messages.length - 1 ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        msg.content
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {sqlStatus && (
                <div className="flex gap-3">
                  <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-secondary border border-border">
                    <Database className="h-4 w-4 text-primary animate-pulse" />
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl rounded-tl-sm bg-primary/10 border border-primary/20 text-sm text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {sqlStatus}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <CardFooter className="p-3 border-t bg-card shrink-0">
            <form onSubmit={handleSubmit} className="flex w-full items-center gap-2">
              <Input
                type="text"
                placeholder="Ask about nodal basis risk, candidate scores, interconnection queues..."
                value={input}
                onChange={e => setInput(e.target.value)}
                className="flex-1 bg-background"
                disabled={isLoading}
              />
              <Button type="submit" size="icon" disabled={!input.trim() || isLoading}>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </CardFooter>
        </div>

        <p className="text-xs text-muted-foreground text-center shrink-0">
          Copilot can query live DB data — ERCOT, CAISO, PJM prices · 3,875 EIA candidates · Interconnection queues
        </p>
      </div>
    </div>
  );
}
