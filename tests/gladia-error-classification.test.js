const test = require('node:test');
const assert = require('node:assert/strict');
const gladia = require('../electron/services/gladia');

test('Gladia errors distinguish quota, concurrency, rate limit, auth and empty-independent service errors', () => {
    const classify = gladia._test.classifyGladiaError;
    assert.equal(classify('429 quota exceeded: insufficient credits').type, 'quota');
    assert.equal(classify('429 maximum concurrent transcriptions reached').type, 'concurrency');
    assert.equal(classify('429 too many requests').type, 'rate_limit');
    assert.equal(classify('401 Unauthorized invalid API key').type, 'auth');
    assert.equal(classify('503 Service unavailable').type, 'service');
});
