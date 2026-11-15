const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, generateAnswer } = require('../providers');
const content = [{ type: 'text', text: 'Solve this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }];
for (const provider of Object.keys(PROVIDERS)) {
    test(`${provider}: routes credentials, model, and screenshots correctly`, async () => {
        const result = await generateAnswer(provider, { key: 'secret', model: 'chosen-model' }, content, async (url, options) => {
            assert.equal(url, PROVIDERS[provider].url);
            const body = JSON.parse(options.body);
            assert.equal(body.model, 'chosen-model');
            assert.equal(body.messages[0].content[0].text, 'Solve this');
            if (provider === 'anthropic') {
                assert.equal(options.headers['x-api-key'], 'secret');
                assert.equal(options.headers.Authorization, undefined);
                assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
                assert.equal(body.max_tokens, 5000);
            } else {
                assert.equal(options.headers.Authorization, 'Bearer secret');
                assert.deepEqual(body.messages[0].content, content);
                assert.equal(body[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'], 5000);
            }
            return { ok: true, json: async () => provider === 'anthropic'
                ? { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Answer' }] }
                : { choices: [{ message: { content: 'Answer' } }] } };
        });
        assert.equal(result, 'Answer');
    });
}
test('API errors do not expose upstream content or keys', async () => {
    await assert.rejects(generateAnswer('openrouter', { key: 'secret', model: 'model' }, content,
        async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret' }) })), /HTTP 401/);
});
test('empty responses and missing credentials are rejected', async () => {
    await assert.rejects(generateAnswer('openai', {}, content), /Configure/);
    await assert.rejects(generateAnswer('anthropic', { key: 'secret', model: 'model' }, content,
        async () => ({ ok: true, json: async () => ({ content: [] }) })), /no text/);
});
