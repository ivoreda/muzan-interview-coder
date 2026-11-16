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

for (const [error, expected] of [
    [{ code: 'insufficient_quota' }, /API credits or usage quota exhausted/],
    [{ code: 'credit_balance_exhausted', type: 'insufficient_quota' }, /API credits or usage quota exhausted/],
    [{ code: 'rate_limit_exceeded' }, /API rate limit reached/],
    [{ type: 'rate_limit_error', code: 'slow_down' }, /API rate limit reached/],
    [{ code: 'unknown' }, /rate or quota limit/]
]) {
    test(`429 classification: ${JSON.stringify(error)}`, async () => {
        let calls = 0;
        await assert.rejects(generateAnswer('openai', { key: 'secret', model: 'model' }, content, async () => {
            calls++;
            return { ok: false, status: 429, json: async () => ({ error: { ...error, message: 'secret Solve this' } }) };
        }), err => {
            assert.match(err.message, expected);
            assert.doesNotMatch(err.message, /secret|Solve this/);
            return true;
        });
        assert.equal(calls, 1);
    });
}

test('non-JSON 429 responses retain useful guidance', async () => {
    await assert.rejects(generateAnswer('openai', { key: 'secret', model: 'model' }, content,
        async () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError('secret'); } })), /rate or quota limit/);
});

for (const provider of Object.keys(PROVIDERS)) {
    test(`${provider}: streams history and JPEG screenshots with cancellation`, async () => {
        const controller = new AbortController();
        const deltas = [];
        const messages = [
            { role: 'system', content: 'Instructions' },
            { role: 'user', content: 'Previous question' },
            { role: 'assistant', content: 'Previous answer' },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } }] }
        ];
        const result = await generateAnswer(provider, { key: 'secret', model: 'gpt-5-nano' }, [], async (_, options) => {
            const body = JSON.parse(options.body);
            assert.equal(body.stream, true);
            assert.equal(body.max_completion_tokens || body.max_tokens, 16000);
            if (provider === 'anthropic') {
                assert.equal(body.system, 'Instructions');
                assert.equal(body.messages[2].content[0].source.media_type, 'image/jpeg');
            } else {
                assert.deepEqual(body.messages, messages);
                if (provider === 'openai') assert.equal(body.reasoning_effort, 'low');
            }
            controller.abort();
            assert.equal(options.signal.aborted, true);
            const events = provider === 'anthropic'
                ? [{ type: 'content_block_delta', delta: { text: 'Answer' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]
                : [{ choices: [{ delta: { content: 'Answer' } }] }, { choices: [{ finish_reason: 'length' }] }];
            const encoded = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
            return { ok: true, body: (async function* () { yield encoded.slice(0, 17); yield encoded.slice(17); })() };
        }, { messages, signal: controller.signal, onDelta: delta => deltas.push(delta), reasoningEffort: 'low' });
        assert.deepEqual(deltas, ['Answer']);
        assert.deepEqual(result, { text: 'Answer', finishReason: 'length' });
    });
}
