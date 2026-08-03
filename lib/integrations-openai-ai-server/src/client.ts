import OpenAI from "openai";

/**
 * LLM client — OpenAI SDK shape, but NOT necessarily OpenAI.
 *
 * This project actually runs against NVIDIA NIM
 * (https://integrate.api.nvidia.com/v1, key format `nvapi-...`,
 * model `meta/llama-3.3-70b-instruct`). The variables were named
 * AI_INTEGRATIONS_OPENAI_* by the Replit integration that originally
 * provisioned them, which is misleading — reading the .env suggests an
 * OpenAI key is present when it is an NVIDIA one.
 *
 * So LLM_API_KEY / LLM_BASE_URL are now the preferred names, with the old
 * AI_INTEGRATIONS_OPENAI_* kept as a fallback so nothing breaks before the
 * .env is updated. Set either pair; the new names win.
 *
 * The SDK is still `openai` because NIM speaks the OpenAI-compatible API —
 * that is a wire-protocol choice, not a statement about the provider.
 */
const BASE_URL =
  process.env.LLM_BASE_URL ?? process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const API_KEY =
  process.env.LLM_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

if (!BASE_URL) {
  throw new Error(
    "LLM_BASE_URL (or legacy AI_INTEGRATIONS_OPENAI_BASE_URL) must be set. " +
      "For NVIDIA NIM use https://integrate.api.nvidia.com/v1",
  );
}

if (!API_KEY) {
  throw new Error(
    "LLM_API_KEY (or legacy AI_INTEGRATIONS_OPENAI_API_KEY) must be set. " +
      "NVIDIA NIM keys start with `nvapi-`; get one free at https://build.nvidia.com",
  );
}

/**
 * Timeout + retry.
 *
 * Measured on NVIDIA's free tier 2026-08-03, prompt "say ok", max_tokens 64:
 *   meta/llama-3.3-70b-instruct  → 112 s   (and an outright 504 on one attempt)
 *   meta/llama-3.1-8b-instruct   →   0.4 s
 * The 70B models are queued behind shared capacity. nginx's default
 * proxy_read_timeout is 60 s, so anything past that dies at the proxy even
 * when the provider eventually answers — the request is unrecoverable, just
 * slow enough to look like a hang.
 *
 * So: fail at 45 s, inside nginx's window, with a real error the route can
 * log. Without this the SDK waits ~10 min by default and the user sees a
 * spinner forever.
 */
export const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  timeout: Number(process.env.LLM_TIMEOUT_MS ?? 45_000),
  maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 1),
});
