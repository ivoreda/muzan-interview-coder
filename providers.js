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
    // Do not surface raw upstream errors, which may echo credentials or input.
    if (!response.ok) throw new Error(`${definition.name} request failed (HTTP ${response.status}). Check your key, model access, credits, and image support in settings.`);
    const result = await response.json();
    const text = anthropic
        ? result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n\n')
        : result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${definition.name} returned no text answer. Try another model.`);
    return text;
}
module.exports = { PROVIDERS, generateAnswer };
