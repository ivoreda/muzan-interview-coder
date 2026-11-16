const PROVIDERS = {
    openai: { name: 'OpenAI', model: 'gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions' },
    anthropic: { name: 'Anthropic', model: 'claude-sonnet-4-5', url: 'https://api.anthropic.com/v1/messages' },
    openrouter: { name: 'OpenRouter', model: 'openai/gpt-4o-mini', url: 'https://openrouter.ai/api/v1/chat/completions' }
};

async function generateAnswer(provider, profile, content, request = fetch) {
    const definition = PROVIDERS[provider];
    if (!definition || !profile?.key) throw new Error('Configure your AI provider in settings first.');
    const anthropic = provider === 'anthropic';
    const blocks = anthropic ? content.map(part => {
        if (part.type === 'text') return part;
        const match = /^data:image\/png;base64,(.+)$/.exec(part.image_url.url);
        if (!match) throw new Error('Unsupported screenshot format.');
        return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: match[1] } };
    }) : content;
    const response = await request(definition.url, {
        method: 'POST',
        headers: anthropic
            ? { 'Content-Type': 'application/json', 'x-api-key': profile.key, 'anthropic-version': '2023-06-01' }
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.key}` },
        body: JSON.stringify({
            model: profile.model,
            messages: [{ role: 'user', content: blocks }],
            [provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: 5000
        }),
        signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
        // Classify known errors without exposing upstream messages, credentials, or input.
        let error;
        try { error = (await response.json())?.error; } catch { /* Non-JSON error response. */ }
        const prefix = `${definition.name} request failed (HTTP ${response.status}).`;
        if (response.status === 429) {
            const codes = [error?.code, error?.type];
            if (codes.some(code => ['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'usage_limit_reached'].includes(code))) {
                throw new Error(`${prefix} API credits or usage quota exhausted. Check API billing, credit balance, and project usage limits for this key. Retrying will not resolve a billing limit.`);
            }
            if (codes.some(code => ['rate_limit_exceeded', 'rate_limit_error', 'slow_down'].includes(code))) {
                throw new Error(`${prefix} API rate limit reached. Wait before trying again, reduce request frequency or screenshot count, or check your API rate limits.`);
            }
            throw new Error(`${prefix} The provider reported a rate or quota limit. Check API billing and usage limits; if credits are available, wait before trying again.`);
        }
        throw new Error(`${prefix} Check your key, model access, credits, and image support in settings.`);
    }
    const result = await response.json();
    const text = anthropic
        ? result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n\n')
        : result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${definition.name} returned no text answer. Try another model.`);
    return text;
}
module.exports = { PROVIDERS, generateAnswer };
