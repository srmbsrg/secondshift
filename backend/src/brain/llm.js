'use strict';
// Model-agnostic LLM client. Any OpenAI-compatible /chat/completions endpoint works:
// OpenAI, OpenRouter, Azure OpenAI (via compatible gateway), or a local Ollama / LM Studio.
// provider "anthropic" uses Claude via the Messages API (default model is a fast Haiku-class model).
// provider "none" disables it — the rules extractor still runs the call.

function createLlm(cfg = {}) {
  const provider = (cfg.provider || 'none').toLowerCase();
  if (provider === 'none') return null;
  if (provider === 'anthropic') return createAnthropic(cfg);
  // provider -> [default base URL, default model]. "abacus" = Abacus.AI RouteLLM, OpenAI-compatible,
  // one key reaching Claude and other vendors' models.
  const DEFAULTS = { ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5:0.5b'], abacus: ['https://routellm.abacus.ai/v1', 'claude-haiku-5-5'], openai: ['https://api.openai.com/v1', 'gpt-4o-mini'] };
  const [defBase, defModel] = DEFAULTS[provider] || DEFAULTS.openai;
  const baseUrl = (cfg.baseUrl || defBase).replace(/\/$/, '');
  const model = cfg.model || defModel;
  const apiKey = cfg.apiKey || '';
  const timeoutMs = cfg.timeoutMs || 5000;
  if (provider === 'abacus' && !apiKey) return null;
  // Abacus serves claude-haiku-5-5 with hidden reasoning on (~350 tokens, ~3.5 s for a long caller turn);
  // "minimal" brings it to ~0.7 s with the same extraction. Override with SECONDSHIFT_LLM_REASONING.
  const reasoningEffort = cfg.reasoningEffort !== undefined ? cfg.reasoningEffort : provider === 'abacus' ? 'minimal' : null;
  return {
    provider, model,
    /** Ask for a JSON object; returns parsed object or null (never throws into the call). */
    async json(system, user) {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) return null;
        const m = text.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : null;
      } catch { return null; } finally { clearTimeout(timer); }
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
  return {
    provider: 'anthropic', model,
    async json(system, user) {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 300, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const m = text.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : null;
      } catch { return null; } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { createLlm };
