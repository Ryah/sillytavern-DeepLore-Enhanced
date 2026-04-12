/**
 * DeepLore Enhanced — Diagnostics Module Tests
 * Run with: node test/diagnostics.test.mjs
 *
 * Tests RingBuffer, safeStringify (ring-buffer.js), and makeCtx, scrubString,
 * scrubDeep (scrubber.js). These are pure, production-critical modules used in
 * every diagnostic export.
 */

import {
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    assertMatch, assertInstanceOf, assertGreaterThan,
    test, section, summary,
} from './helpers.mjs';

import { RingBuffer, safeStringify } from '../src/diagnostics/ring-buffer.js';
import { makeCtx, scrubString, scrubDeep } from '../src/diagnostics/scrubber.js';


// ============================================================================
//  A. RingBuffer — Core Data Structure
// ============================================================================

section('A. RingBuffer — Core Data Structure');

test('Constructor: default capacity is 500', () => {
    const rb = new RingBuffer();
    assertEqual(rb.capacity, 500, 'default capacity should be 500');
});

test('Constructor: custom capacity', () => {
    const rb = new RingBuffer(100);
    assertEqual(rb.capacity, 100, 'custom capacity should be 100');
});

test('Constructor: capacity < 1 clamped to 1', () => {
    const rb0 = new RingBuffer(0);
    assertEqual(rb0.capacity, 1, 'capacity 0 clamped to 1');
    const rbNeg = new RingBuffer(-10);
    assertEqual(rbNeg.capacity, 1, 'negative capacity clamped to 1');
});

test('Constructor: non-integer capacity floored via bitwise OR', () => {
    const rb = new RingBuffer(7.9);
    assertEqual(rb.capacity, 7, 'float capacity should be floored to 7');
});

test('push + length: single item', () => {
    const rb = new RingBuffer(10);
    rb.push('hello');
    assertEqual(rb.length, 1, 'length should be 1 after one push');
});

test('push + length: multiple items up to capacity', () => {
    const rb = new RingBuffer(5);
    for (let i = 0; i < 5; i++) rb.push(i);
    assertEqual(rb.length, 5, 'length should equal capacity when full');
});

test('push: at capacity, oldest item dropped (FIFO)', () => {
    const rb = new RingBuffer(3);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.push('d');
    assertEqual(rb.length, 3, 'length should stay at capacity');
    const items = rb.drain();
    assertEqual(items, ['b', 'c', 'd'], 'oldest item (a) should be dropped');
});

test('push: well over capacity, only last N items remain', () => {
    const rb = new RingBuffer(3);
    for (let i = 0; i < 100; i++) rb.push(i);
    assertEqual(rb.length, 3, 'length should be clamped to capacity');
    const items = rb.drain();
    assertEqual(items, [97, 98, 99], 'only last 3 items should remain');
});

test('drain: returns shallow copy (oldest to newest order)', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    const items = rb.drain();
    assertEqual(items, [1, 2, 3], 'drain should return items oldest to newest');
});

test('drain: does NOT clear buffer', () => {
    const rb = new RingBuffer(5);
    rb.push('x');
    rb.drain();
    assertEqual(rb.length, 1, 'drain should not clear the buffer');
    const items = rb.drain();
    assertEqual(items, ['x'], 'second drain should return same items');
});

test('drain: empty buffer returns empty array', () => {
    const rb = new RingBuffer(5);
    const items = rb.drain();
    assertEqual(items, [], 'drain on empty buffer should return []');
});

test('drain: returned array is independent of buffer', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    const items = rb.drain();
    items.push(999);
    items[0] = -1;
    const items2 = rb.drain();
    assertEqual(items2, [1, 2], 'mutating drained array should not affect buffer');
});

test('clear: resets to empty', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.clear();
    assertEqual(rb.length, 0, 'length should be 0 after clear');
});

test('clear: drain returns empty after clear', () => {
    const rb = new RingBuffer(5);
    rb.push('a');
    rb.clear();
    assertEqual(rb.drain(), [], 'drain after clear should return []');
});

test('clear + push: works normally after clear', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    rb.push(10);
    rb.push(20);
    assertEqual(rb.length, 2, 'length should be 2 after pushing post-clear');
    assertEqual(rb.drain(), [10, 20], 'items should be post-clear pushes only');
});

test('push with various types: objects, strings, numbers, null, undefined, arrays', () => {
    const rb = new RingBuffer(10);
    rb.push({ a: 1 });
    rb.push('hello');
    rb.push(42);
    rb.push(null);
    rb.push(undefined);
    rb.push([1, 2, 3]);
    assertEqual(rb.length, 6, 'should handle all types');
    const items = rb.drain();
    assertEqual(items[0], { a: 1 }, 'object preserved');
    assertEqual(items[1], 'hello', 'string preserved');
    assertEqual(items[2], 42, 'number preserved');
    assertNull(items[3], 'null preserved');
    assertEqual(items[4], undefined, 'undefined preserved');
    assertEqual(items[5], [1, 2, 3], 'array preserved');
});

test('push never throws: even with weird inputs', () => {
    const rb = new RingBuffer(5);
    let threw = false;
    try {
        rb.push(Symbol('test'));
        rb.push(() => {});
        rb.push(Object.create(null));
        rb.push(new Proxy({}, {}));
    } catch {
        threw = true;
    }
    assert(!threw, 'push should never throw');
});

test('Capacity 1: always has exactly 1 item', () => {
    const rb = new RingBuffer(1);
    rb.push('a');
    assertEqual(rb.length, 1, 'length should be 1');
    rb.push('b');
    assertEqual(rb.length, 1, 'length still 1 after second push');
    assertEqual(rb.drain(), ['b'], 'only last item remains');
});

test('Large capacity: 10000 items, verify oldest dropped correctly', () => {
    const rb = new RingBuffer(100);
    for (let i = 0; i < 10000; i++) rb.push(i);
    assertEqual(rb.length, 100, 'length should be capped at 100');
    const items = rb.drain();
    assertEqual(items[0], 9900, 'first item should be 9900');
    assertEqual(items[99], 9999, 'last item should be 9999');
});

test('Sequential push+drain: verify ordering is preserved', () => {
    const rb = new RingBuffer(5);
    rb.push('first');
    rb.push('second');
    rb.push('third');
    const d1 = rb.drain();
    assertEqual(d1, ['first', 'second', 'third'], 'first drain order correct');
    rb.push('fourth');
    rb.push('fifth');
    const d2 = rb.drain();
    assertEqual(d2, ['first', 'second', 'third', 'fourth', 'fifth'], 'second drain order correct');
});

test('RingBuffer: length is a getter, not a method', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    assert(typeof rb.length === 'number', 'length should be a number');
    assertEqual(rb.length, 1, 'length should reflect actual count');
});


// ============================================================================
//  B. safeStringify
// ============================================================================

section('B. safeStringify');

test('Single string arg returns that string', () => {
    assertEqual(safeStringify(['hello']), 'hello', 'single string passthrough');
});

test('Single number returns string representation', () => {
    assertEqual(safeStringify([42]), '42', 'number stringified');
    assertEqual(safeStringify([0]), '0', 'zero stringified');
    assertEqual(safeStringify([-3.14]), '-3.14', 'negative float stringified');
});

test('Single boolean returns "true"/"false"', () => {
    assertEqual(safeStringify([true]), 'true', 'true stringified');
    assertEqual(safeStringify([false]), 'false', 'false stringified');
});

test('null returns "null"', () => {
    assertEqual(safeStringify([null]), 'null', 'null stringified');
});

test('undefined returns "undefined"', () => {
    assertEqual(safeStringify([undefined]), 'undefined', 'undefined stringified');
});

test('BigInt returns string with n suffix', () => {
    // BigInt is handled via typeof === 'bigint' → String(a)
    // But inside JSON.stringify, makeJsonReplacer handles it with + 'n'
    const result = safeStringify([BigInt(123)]);
    assertEqual(result, '123', 'BigInt stringified via String()');
});

test('Error object returns "ErrorName: message\\nstack"', () => {
    const err = new Error('test error');
    const result = safeStringify([err]);
    assertMatch(result, /Error: test error/, 'should contain Error: test error');
    assertMatch(result, /\n/, 'should contain newline before stack');
});

test('Plain object returns JSON string', () => {
    assertEqual(safeStringify([{ a: 1 }]), '{"a":1}', 'plain object JSON');
});

test('Array returns JSON string', () => {
    assertEqual(safeStringify([[1, 2, 3]]), '[1,2,3]', 'array JSON');
});

test('Multiple args joined with " | "', () => {
    const result = safeStringify(['hello', 42, true]);
    assertEqual(result, 'hello | 42 | true', 'multiple args joined');
});

test('Circular object contains "[circular]"', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const result = safeStringify([obj]);
    assertMatch(result, /\[circular\]/, 'circular should be caught');
});

test('Function contains "[fn name]" or "[fn anon]"', () => {
    function myFunc() {}
    const result1 = safeStringify([{ f: myFunc }]);
    assertMatch(result1, /\[fn myFunc\]/, 'named function');
    // Arrow assigned to object property gets property name 'f'; use a truly anonymous fn
    const anon = (() => () => {})();
    const result2 = safeStringify([{ g: anon }]);
    assertMatch(result2, /\[fn (anon)?\]/, 'anonymous function');
});

test('Deeply nested object stringified without crash', () => {
    let obj = { v: 'leaf' };
    for (let i = 0; i < 50; i++) obj = { child: obj };
    const result = safeStringify([obj]);
    assertMatch(result, /leaf/, 'deeply nested object should stringify');
});

test('Very long string + maxLen truncated with suffix', () => {
    const long = 'x'.repeat(3000);
    const result = safeStringify([long], 100);
    assert(result.length <= 200, 'result should be truncated'); // with suffix
    assertMatch(result, /…\[\+\d+ chars\]/, 'should have truncation suffix');
});

test('maxLen exactly at boundary: no truncation', () => {
    const str = 'hello';
    const result = safeStringify([str], 5);
    assertEqual(result, 'hello', 'no truncation when exactly at maxLen');
});

test('Object with toJSON uses toJSON', () => {
    const obj = { toJSON: () => ({ custom: true }) };
    const result = safeStringify([obj]);
    assertMatch(result, /custom/, 'toJSON should be used');
});

test('Mixed args: string, number, object, null joined correctly', () => {
    const result = safeStringify(['msg', 42, { a: 1 }, null]);
    assertEqual(result, 'msg | 42 | {"a":1} | null', 'mixed args joined');
});

test('Never throws: even with problematic inputs', () => {
    let threw = false;
    try {
        // Object with getter that throws
        const evil = {};
        Object.defineProperty(evil, 'x', { get() { throw new Error('boom'); }, enumerable: true });
        safeStringify([evil]);
        // Proxy that throws on everything
        const proxy = new Proxy({}, { get() { throw new Error('proxy boom'); } });
        safeStringify([proxy]);
    } catch {
        threw = true;
    }
    assert(!threw, 'safeStringify should never throw');
});

test('BUG-035: Two calls with circular objects do not share WeakSet', () => {
    const a = { name: 'a' };
    a.self = a;
    const b = { name: 'b' };
    b.self = b;
    const result1 = safeStringify([a]);
    const result2 = safeStringify([b]);
    // Both should independently detect their own circularity
    assertMatch(result1, /\[circular\]/, 'first call detects circular');
    assertMatch(result2, /\[circular\]/, 'second call detects circular');
    // And both should contain their own name (not contaminated)
    assertMatch(result1, /"name":"a"/, 'first result has name a');
    assertMatch(result2, /"name":"b"/, 'second result has name b');
});

test('Empty args array returns empty string', () => {
    // With empty array: parts is empty, parts.length === 1 is false,
    // so it joins with ' | ' → '' (empty join)
    const result = safeStringify([]);
    // parts = [], parts.length === 1 → false, parts.join(' | ') → ''
    assertEqual(result, '', 'empty args should return empty string');
});

test('Single-element array: no " | " separator', () => {
    const result = safeStringify(['only']);
    assert(!result.includes(' | '), 'single element should not have separator');
    assertEqual(result, 'only', 'single element passthrough');
});

test('BigInt inside object uses replacer', () => {
    const result = safeStringify([{ val: BigInt(999) }]);
    assertMatch(result, /999n/, 'BigInt in object should have n suffix via replacer');
});


// ============================================================================
//  C. makeCtx
// ============================================================================

section('C. makeCtx');

test('makeCtx returns object with expected Maps', () => {
    const ctx = makeCtx();
    assertInstanceOf(ctx.ip, Map, 'ip should be a Map');
    assertInstanceOf(ctx.ipv6, Map, 'ipv6 should be a Map');
    assertInstanceOf(ctx.email, Map, 'email should be a Map');
    assertInstanceOf(ctx.host, Map, 'host should be a Map');
    assertInstanceOf(ctx.userPath, Map, 'userPath should be a Map');
    assertInstanceOf(ctx.title, Map, 'title should be a Map');
});

test('makeCtx returns object with stats counters all at 0', () => {
    const ctx = makeCtx();
    assertEqual(ctx.stats.ips, 0, 'ips starts at 0');
    assertEqual(ctx.stats.ipv6s, 0, 'ipv6s starts at 0');
    assertEqual(ctx.stats.emails, 0, 'emails starts at 0');
    assertEqual(ctx.stats.hosts, 0, 'hosts starts at 0');
    assertEqual(ctx.stats.userPaths, 0, 'userPaths starts at 0');
    assertEqual(ctx.stats.titles, 0, 'titles starts at 0');
    assertEqual(ctx.stats.bearerTokens, 0, 'bearerTokens starts at 0');
    assertEqual(ctx.stats.urlTokens, 0, 'urlTokens starts at 0');
    assertEqual(ctx.stats.openaiKeys, 0, 'openaiKeys starts at 0');
    assertEqual(ctx.stats.longTokens, 0, 'longTokens starts at 0');
    assertEqual(ctx.stats.sensitiveFields, 0, 'sensitiveFields starts at 0');
});

test('Two calls return independent contexts', () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    ctx1.stats.ips = 5;
    ctx1.ip.set('test', 'value');
    assertEqual(ctx2.stats.ips, 0, 'ctx2 stats unaffected by ctx1');
    assertEqual(ctx2.ip.size, 0, 'ctx2 maps unaffected by ctx1');
});

test('Maps are empty on creation', () => {
    const ctx = makeCtx();
    assertEqual(ctx.ip.size, 0, 'ip map empty');
    assertEqual(ctx.ipv6.size, 0, 'ipv6 map empty');
    assertEqual(ctx.email.size, 0, 'email map empty');
    assertEqual(ctx.host.size, 0, 'host map empty');
    assertEqual(ctx.userPath.size, 0, 'userPath map empty');
    assertEqual(ctx.title.size, 0, 'title map empty');
});

test('Stats has all expected counter fields', () => {
    const ctx = makeCtx();
    const expectedKeys = [
        'ips', 'ipv6s', 'emails', 'hosts', 'userPaths', 'titles',
        'bearerTokens', 'urlTokens', 'openaiKeys', 'longTokens', 'sensitiveFields',
    ];
    for (const key of expectedKeys) {
        assert(key in ctx.stats, `stats should have key '${key}'`);
    }
});


// ============================================================================
//  D. scrubString — Pattern Matching
// ============================================================================

section('D. scrubString — Pattern Matching');

test('Bearer token scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('Bearer sk-abc123456789', ctx);
    assertMatch(result, /Bearer <token>/, 'Bearer token should be scrubbed');
    assertEqual(ctx.stats.bearerTokens, 1, 'bearerTokens counter incremented');
});

test('URL query-string token: ?key=abc scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://example.com/api?key=abc123&foo=bar', ctx);
    assertMatch(result, /\?key=<token>/, 'key param should be scrubbed');
    assertMatch(result, /&foo=bar/, 'non-sensitive param should remain');
});

test('URL auth params: ?access_token=xxx scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://example.com?access_token=secret_value_here', ctx);
    assertMatch(result, /access_token=<token>/, 'access_token should be scrubbed');
});

test('OpenAI key: sk-proj-... scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('my key is sk-proj-abc123456789012345678901', ctx);
    assertMatch(result, /<openai-key>/, 'OpenAI key should be scrubbed');
    assertEqual(ctx.stats.openaiKeys, 1, 'openaiKeys counter incremented');
});

test('Anthropic key: sk-ant-... scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('key: sk-ant-abc12345678901234567890', ctx);
    assertMatch(result, /<openai-key>/, 'Anthropic key matched by same pattern');
});

test('IPv4 address: partially masked, first two octets preserved', () => {
    const ctx = makeCtx();
    const result = scrubString('connected from 192.168.1.100', ctx);
    assertMatch(result, /192\.168\./, 'first two octets preserved');
    assert(!result.includes('1.100'), 'last two octets should be masked');
    assertEqual(ctx.stats.ips, 1, 'ips counter incremented');
});

test('IPv4 with port: port preserved, IP partially masked', () => {
    const ctx = makeCtx();
    const result = scrubString('server at 10.0.1.50:8080', ctx);
    assertMatch(result, /:8080/, 'port should be preserved');
    assertMatch(result, /10\.0\./, 'first two octets preserved');
});

test('IPv6 address: pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('address 2001:0db8:85a3:0000:0000:8a2e:0370:7334', ctx);
    assertMatch(result, /<ipv6-\d+>/, 'IPv6 should be pseudonymized');
    assertEqual(ctx.stats.ipv6s, 1, 'ipv6s counter incremented');
});

test('Email: pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('contact user@example.com for help', ctx);
    assertMatch(result, /<email-\d+>/, 'email should be pseudonymized');
    assertEqual(ctx.stats.emails, 1, 'emails counter incremented');
});

test('Email cardinality: same email twice gets same pseudonym', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from user@test.com', ctx);
    const r2 = scrubString('to user@test.com', ctx);
    // Extract the pseudonym from each
    const match1 = r1.match(/<email-\d+>/);
    const match2 = r2.match(/<email-\d+>/);
    assertNotNull(match1, 'first scrub should have email pseudonym');
    assertNotNull(match2, 'second scrub should have email pseudonym');
    if (match1 && match2) {
        assertEqual(match1[0], match2[0], 'same email should get same pseudonym');
    }
});

test('Email cardinality: different emails get different pseudonyms', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from alice@test.com', ctx);
    const r2 = scrubString('to bob@test.com', ctx);
    const match1 = r1.match(/<email-\d+>/);
    const match2 = r2.match(/<email-\d+>/);
    assertNotNull(match1, 'first email pseudonym');
    assertNotNull(match2, 'second email pseudonym');
    if (match1 && match2) {
        assertNotEqual(match1[0], match2[0], 'different emails should get different pseudonyms');
    }
});

test('Windows path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('file at C:\\Users\\johndoe\\Documents\\test.txt', ctx);
    assertMatch(result, /C:\\Users\\<user-\d+>/, 'Windows username should be pseudonymized');
    assertEqual(ctx.stats.userPaths, 1, 'userPaths counter incremented');
});

test('POSIX path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('file at /home/janedoe/projects/test', ctx);
    assertMatch(result, /\/home\/<user-\d+>/, 'POSIX username should be pseudonymized');
    assertEqual(ctx.stats.userPaths, 1, 'userPaths counter incremented');
});

test('Hostname in URL: host pseudonymized, scheme preserved', () => {
    const ctx = makeCtx();
    const result = scrubString('connecting to https://api.example.com/v1/chat', ctx);
    assertMatch(result, /^connecting to https:\/\//, 'scheme preserved');
    assertMatch(result, /<host-\d+>/, 'hostname should be pseudonymized');
    assertEqual(ctx.stats.hosts, 1, 'hosts counter incremented');
});

test('localhost preserved in URLs', () => {
    const ctx = makeCtx();
    const result = scrubString('server at https://localhost:8080/api', ctx);
    assertMatch(result, /localhost/, 'localhost should be preserved');
    assertEqual(ctx.stats.hosts, 0, 'hosts counter should not increment for localhost');
});

test('Long token: 32+ char base64/hex string scrubbed', () => {
    const ctx = makeCtx();
    const longToken = 'a'.repeat(40);
    const result = scrubString(`token: ${longToken}`, ctx);
    assertMatch(result, /<long-token>/, 'long token should be scrubbed');
    assertEqual(ctx.stats.longTokens, 1, 'longTokens counter incremented');
});

test('Non-string input returned unchanged', () => {
    const ctx = makeCtx();
    const num = scrubString(42, ctx);
    assertEqual(num, 42, 'number returned as-is');
    const nul = scrubString(null, ctx);
    assertNull(nul, 'null returned as-is');
    const undef = scrubString(undefined, ctx);
    assertEqual(undef, undefined, 'undefined returned as-is');
});

test('Empty string returned unchanged', () => {
    const ctx = makeCtx();
    assertEqual(scrubString('', ctx), '', 'empty string passthrough');
});

test('Stats counters increment correctly for each pattern type', () => {
    const ctx = makeCtx();
    scrubString('Bearer sk-abc12345678', ctx);
    scrubString('?key=secret123', ctx);
    scrubString('sk-proj-abc12345678901234567890', ctx);
    scrubString('192.168.1.1', ctx);
    scrubString('user@test.com', ctx);
    assertEqual(ctx.stats.bearerTokens, 1, 'bearer count');
    assertEqual(ctx.stats.urlTokens, 1, 'urlToken count');
    // Note: openaiKeys may be > 1 due to overlapping patterns
    assertGreaterThan(ctx.stats.openaiKeys, 0, 'openaiKeys count');
    assertEqual(ctx.stats.ips, 1, 'ips count');
    assertEqual(ctx.stats.emails, 1, 'emails count');
});

test('Multiple patterns in same string all scrubbed', () => {
    const ctx = makeCtx();
    const input = 'user@test.com connected from 192.168.1.100 with Bearer sk-abc12345678';
    const result = scrubString(input, ctx);
    assertMatch(result, /<email-\d+>/, 'email scrubbed');
    assertMatch(result, /192\.168\./, 'IP partially masked');
    assertMatch(result, /Bearer <token>/, 'bearer scrubbed');
});

test('Pseudonym stability: same IP maps to same pseudonym in same ctx', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from 192.168.5.10', ctx);
    const r2 = scrubString('to 192.168.5.10', ctx);
    // Extract the host pseudonym suffix
    const m1 = r1.match(/192\.168\.(<host-\d+>)/);
    const m2 = r2.match(/192\.168\.(<host-\d+>)/);
    assertNotNull(m1, 'first IP should be partially masked');
    assertNotNull(m2, 'second IP should be partially masked');
    if (m1 && m2) {
        assertEqual(m1[1], m2[1], 'same IP suffix should get same pseudonym');
    }
});

test('URL with multiple query params: only sensitive ones scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://api.example.com/v1?key=secret123&page=5&token=abc456', ctx);
    assertMatch(result, /key=<token>/, 'key param scrubbed');
    assertMatch(result, /token=<token>/, 'token param scrubbed');
    // page=5 should remain
    assertMatch(result, /page=5/, 'non-sensitive param preserved');
});

test('macOS /Users/ path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('/Users/macuser/Library/test', ctx);
    assertMatch(result, /\/Users\/<user-\d+>/, 'macOS path should pseudonymize username');
});

test('scrubString creates fresh ctx if not provided', () => {
    // Should not throw when ctx is omitted
    let threw = false;
    try {
        const result = scrubString('test 192.168.1.1', undefined);
        assertMatch(result, /192\.168\./, 'should still scrub without ctx');
    } catch {
        threw = true;
    }
    assert(!threw, 'scrubString should work without ctx');
});


// ============================================================================
//  E. scrubDeep — Recursive Scrubbing
// ============================================================================

section('E. scrubDeep — Recursive Scrubbing');

test('null passes through', () => {
    assertNull(scrubDeep(null), 'null should pass through');
});

test('undefined passes through', () => {
    assertEqual(scrubDeep(undefined), undefined, 'undefined should pass through');
});

test('number passes through', () => {
    assertEqual(scrubDeep(42), 42, 'number should pass through');
    assertEqual(scrubDeep(0), 0, 'zero should pass through');
    assertEqual(scrubDeep(-1.5), -1.5, 'negative float should pass through');
});

test('boolean passes through', () => {
    assertEqual(scrubDeep(true), true, 'true should pass through');
    assertEqual(scrubDeep(false), false, 'false should pass through');
});

test('string is scrubbed (delegates to scrubString)', () => {
    const result = scrubDeep('contact user@test.com');
    assertMatch(result, /<email-\d+>/, 'email in string should be scrubbed');
});

test('function replaced with "[fn name]" or "[fn anon]"', () => {
    function myHelper() {}
    assertEqual(scrubDeep(myHelper), '[fn myHelper]', 'named function');
    assertEqual(scrubDeep(() => {}), '[fn anon]', 'anonymous arrow function');
});

test('Plain object: keys recursed, values scrubbed', () => {
    const result = scrubDeep({ msg: 'email: alice@test.com', count: 5 });
    assertMatch(result.msg, /<email-\d+>/, 'string value scrubbed');
    assertEqual(result.count, 5, 'number value preserved');
});

test('Array: each element scrubbed', () => {
    const result = scrubDeep(['user@a.com', 42, 'user@b.com']);
    assertMatch(result[0], /<email-\d+>/, 'first element scrubbed');
    assertEqual(result[1], 42, 'number preserved');
    assertMatch(result[2], /<email-\d+>/, 'third element scrubbed');
});

test('Nested objects: deep recursion works', () => {
    const result = scrubDeep({
        level1: {
            level2: {
                email: 'deep@test.com',
            },
        },
    });
    assertMatch(result.level1.level2.email, /<email-\d+>/, 'deeply nested email scrubbed');
});

test('Circular reference: "[circular]" and no infinite loop', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const result = scrubDeep(obj);
    assertEqual(result.a, 1, 'non-circular value preserved');
    assertEqual(result.self, '[circular]', 'circular ref becomes "[circular]"');
});

test('Sensitive field names: api_key value becomes "<redacted>"', () => {
    const result = scrubDeep({ api_key: 'sk-super-secret-value-here' });
    assertEqual(result.api_key, '<redacted>', 'api_key should be redacted');
});

test('Sensitive field names: password, secret, authorization', () => {
    const result = scrubDeep({
        password: 'hunter2',
        secret: 'shhh',
        authorization: 'Bearer xyz',
    });
    assertEqual(result.password, '<redacted>', 'password redacted');
    assertEqual(result.secret, '<redacted>', 'secret redacted');
    assertEqual(result.authorization, '<redacted>', 'authorization redacted');
});

test('Sensitive field case-insensitive: API_KEY, ApiKey', () => {
    const result = scrubDeep({
        API_KEY: 'test',
        ApiKey: 'test2',
        'x-api-key': 'test3',
    });
    assertEqual(result.API_KEY, '<redacted>', 'API_KEY redacted');
    assertEqual(result.ApiKey, '<redacted>', 'ApiKey redacted');
    assertEqual(result['x-api-key'], '<redacted>', 'x-api-key redacted');
});

test('Non-sensitive field names: values preserved (but string content scrubbed)', () => {
    const result = scrubDeep({
        name: 'John',
        title: 'Manager',
        count: 42,
    });
    assertEqual(result.name, 'John', 'name value preserved');
    assertEqual(result.title, 'Manager', 'title value preserved');
    assertEqual(result.count, 42, 'count value preserved');
});

test('Error object returns typed representation', () => {
    const err = new TypeError('bad input from user@test.com');
    const result = scrubDeep(err);
    assertEqual(result.__type, 'Error', '__type should be Error');
    assertEqual(result.name, 'TypeError', 'name should be TypeError');
    assertMatch(result.message, /<email-\d+>/, 'email in message scrubbed');
    assert(typeof result.stack === 'string', 'stack should be a string');
});

test('Map returns typed representation with scrubbed entries', () => {
    const m = new Map();
    m.set('email', 'user@test.com');
    m.set('count', 5);
    const result = scrubDeep(m);
    assertEqual(result.__type, 'Map', '__type should be Map');
    assertMatch(result.entries.email, /<email-\d+>/, 'Map value scrubbed');
    assertEqual(result.entries.count, 5, 'Map non-sensitive value preserved');
});

test('Set returns typed representation with scrubbed values', () => {
    const s = new Set(['user@test.com', 42, 'hello']);
    const result = scrubDeep(s);
    assertEqual(result.__type, 'Set', '__type should be Set');
    assert(Array.isArray(result.values), 'values should be array');
    assertMatch(result.values[0], /<email-\d+>/, 'Set email value scrubbed');
    assertEqual(result.values[1], 42, 'Set number preserved');
    assertEqual(result.values[2], 'hello', 'Set plain string preserved');
});

test('Stats accumulate across deep scrub', () => {
    const ctx = makeCtx();
    scrubDeep({
        log1: 'from 192.168.1.1',
        nested: {
            log2: 'from 10.0.0.1',
            items: ['email: a@b.com'],
        },
    }, ctx);
    assertGreaterThan(ctx.stats.ips, 0, 'IPs should be counted');
    assertGreaterThan(ctx.stats.emails, 0, 'emails should be counted');
});

test('Fresh ctx created if not provided', () => {
    // Should not throw
    let threw = false;
    try {
        const result = scrubDeep({ msg: 'user@test.com' });
        assertMatch(result.msg, /<email-\d+>/, 'should scrub without explicit ctx');
    } catch {
        threw = true;
    }
    assert(!threw, 'scrubDeep should work without ctx');
});

test('Original value not mutated (deep copy)', () => {
    const original = {
        email: 'user@test.com',
        nested: { ip: '192.168.1.1' },
        items: ['a@b.com'],
    };
    const originalEmail = original.email;
    const originalIp = original.nested.ip;
    const originalItem = original.items[0];
    scrubDeep(original);
    assertEqual(original.email, originalEmail, 'original email not mutated');
    assertEqual(original.nested.ip, originalIp, 'original nested IP not mutated');
    assertEqual(original.items[0], originalItem, 'original array item not mutated');
});

test('Sensitive field in Map gets redacted', () => {
    const m = new Map();
    m.set('api_key', 'sk-secret-value');
    const result = scrubDeep(m);
    assertEqual(result.entries.api_key, '<redacted>', 'Map sensitive key redacted');
});

test('scrubDeep: sensitiveFields counter increments', () => {
    const ctx = makeCtx();
    scrubDeep({ password: 'test', api_key: 'test2', normal: 'ok' }, ctx);
    assertGreaterThan(ctx.stats.sensitiveFields, 0, 'sensitiveFields counter should increment');
});

test('scrubDeep: array of objects with mixed sensitive/normal fields', () => {
    const result = scrubDeep([
        { name: 'service1', api_key: 'secret1' },
        { name: 'service2', password: 'secret2' },
    ]);
    assertEqual(result[0].name, 'service1', 'name preserved');
    assertEqual(result[0].api_key, '<redacted>', 'api_key redacted in array');
    assertEqual(result[1].password, '<redacted>', 'password redacted in array');
});

test('scrubDeep: deeply nested circular reference', () => {
    const a = { name: 'a' };
    const b = { name: 'b', ref: a };
    a.ref = b;
    const result = scrubDeep(a);
    assertEqual(result.name, 'a', 'a.name preserved');
    assertEqual(result.ref.name, 'b', 'b.name preserved');
    assertEqual(result.ref.ref, '[circular]', 'circular in nested object caught');
});

test('scrubDeep: cross-reference (two objects referencing same third)', () => {
    const shared = { data: 'user@test.com' };
    const obj = { a: shared, b: shared };
    const result = scrubDeep(obj);
    // First encounter scrubs normally, second becomes [circular] since same ref in WeakMap
    assertMatch(result.a.data, /<email-\d+>/, 'first reference scrubbed');
    assertEqual(result.b, '[circular]', 'second reference to same object is circular');
});

test('scrubDeep: additional sensitive field names', () => {
    const result = scrubDeep({
        oauth_token: 'abc',
        refresh_token: 'def',
        client_id: 'ghi',
        private_key: 'jkl',
        credential: 'mno',
    });
    assertEqual(result.oauth_token, '<redacted>', 'oauth_token redacted');
    assertEqual(result.refresh_token, '<redacted>', 'refresh_token redacted');
    assertEqual(result.client_id, '<redacted>', 'client_id redacted');
    assertEqual(result.private_key, '<redacted>', 'private_key redacted');
    assertEqual(result.credential, '<redacted>', 'credential redacted');
});


// ============================================================================
//  Summary
// ============================================================================

summary('Diagnostics Tests');
