'use strict';
// Model-agnostic LLM client. Any OpenAI-compatible /chat/completions endpoint works:
// OpenAI, OpenRouter, Azure OpenAI (via compatible gateway), or a local Ollama / LM Studio / llama.cpp server.
// provider "anthropic" uses Claude via the Messages API (default model is a fast Haiku-class model).
// provider "none" disables it Ã¢â‚¬â€ the rules extractor still runs the call.
//
// Every call takes an optional `meta` object that is filled in with what happened ({status, usage,
// error}) so the model router (router.js) can meter spend and spot out-of-credit errors without
// changing the return contract: the methods still return a parsed object or null and never throw.

const PAID = new Set(['abacus', 'anthropic', 'openai']);

function noteHttp(meta, res, text) {
  if (!meta) return;
  meta.status = res.status;
  if (!res.ok) meta.error = String(text || '').slice(0, 300);
}
function noteUsage(meta, usage) {
  if (!meta || !usage) return;
  // OpenAI-compatible: prompt_tokens / completion_tokens. Anthropic: input_tokens / output_tokens.
  meta.usage = {
    input: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}
function noteFail(meta, e) { if (meta && !meta.status) meta.error = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 200); }

function createLlm(cfg = {}) {
  const provider = (cfg.provider || 'none').toLowerCase();
  if (provider === 'none') return null;
  if (provider === 'anthropic') return createAnthropic(cfg);
  // provider -> [default base URL, default model]. "abacus" = Abacus.AI RouteLLM, OpenAI-compatible,
  // one key reaching Claude and other vendors' models. "local" = any OpenAI-compatible server we run
  // ourselves (Ollama, llama.cpp server, LM Studio); "ollama" is kept as an alias.
  const DEFAULTS = { local: ['http://127.0.0.1:11434/v1', 'llama3.1:8b'], ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5:0.5b'], abacus: ['https://routellm.abacus.ai/v1', 'claude-haiku-5-5'], openai: ['https://api.openai.com/v1', 'gpt-4o-mini'] };
  const [defBase, defModel] = DEFAULTS[provider] || DEFAULTS.openai;
  const baseUrl = (cfg.baseUrl || defBase).replace(/\/$/, '');
  const model = cfg.model || defModel;
  const apiKey = cfg.apiKey || '';
  const timeoutMs = cfg.timeoutMs || 5000;
  if (provider === 'abacus' && !apiKey) return null;
  // Abacus serves claude-haiku-5-5 with hidden reasoning on (~350 tokens, ~3.5 s for a long caller turn);
  // "minimal" brings it to ~0.7 s with the same extraction. Override with SECONDSHIFT_LLM_REASONING.
  const reasoningEffort = cfg.reasoningEffort !== undefined ? cfg.reasoningEffort : provider === 'abacus' ? 'minimal' : null;

  async function call(body, t, meta) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), t);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, ...body, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
      });
      if (!res.ok) { noteHttp(meta, res, await res.text().catch(() => '')); return null; }
      noteHttp(meta, res);
      const data = await res.json();
      noteUsage(meta, data && data.usage);
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const m = text && text.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { noteFail(meta, e); return null; } finally { clearTimeout(timer); }
  }

  return {
    provider, model, paid: PAID.has(provider) && !!apiKey,
    /** Opens the connection (TLS + keep-alive) at call start so the first real model turn is faster. */
    warm() { return this.json('Reply with the JSON object {}', 'ping').catch(() => null); },
    /** Ask for a JSON object; returns parsed object or null (never throws into the call). */
    json(system, user, meta) {
      return call({ temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, timeoutMs, meta);
    },
    /** Multi-turn: system + [{role:'user'|'assistant', content}] -> parsed JSON object | null. */
    chatJson(system, messages, { maxTokens = 400, timeoutMs: t = 12000, meta } = {}) {
      return call({ temperature: 0.3, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...messages] }, t, meta);
    },
  };
}

// Claude (Anthropic Messages API). Same contract as above: .json(system, user) -> object | null.
function createAnthropic(cfg) {
  const baseUrl = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const model = cfg.model || 'claude-haiku-5-5';
  const apiKey = cfg.apiKey || '';
  const timeoutMs = cfg.timeoutMs || 5000;
  if (!apiKey) return null;
  async function call(body, t, meta) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), t);
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, ...body }),
      });
      if (!res.ok) { noteHttp(meta, res, await res.text().catch(() => '')); return null; }
      noteHttp(meta, res);
      const data = await res.json();
      noteUsage(meta, data && data.usage);
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const m = text.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { noteFail(meta, e); return null; } finally { clearTimeout(timer); }
  }
  return {
    provider: 'anthropic', model, paid: true,
    /** Opens the connection (TLS + keep-alive) at call start so the first real model turn is faster. */
    warm() { return this.json('Reply with the JSON object {}', 'ping').catch(() => null); },
    json(system, user, meta) {
      return call({ max_tokens: 300, temperature: 0, system, messages: [{ role: 'user', content: user }] }, timeoutMs, meta);
    },
    chatJson(system, messages, { maxTokens = 400, timeoutMs: t = 12000, meta } = {}) {
      return call({ max_tokens: maxTokens, temperature: 0.3, system, messages }, t, meta);
    },
  };
}

module.exports = { createLlm, PAID };
