// F-C3 YouTube checks (03-state-flows, section 8): format first, then the
// public oEmbed endpoint. No network here: fetch is a stand-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const yt = require('../lib/youtube');

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

test('format: watch, youtu.be and shorts links give the id and the canonical watch url', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?feature=share&v=${ID}&t=42s`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123&t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `  https://youtu.be/${ID}  `,
  ]) {
    assert.deepEqual(yt.parseYouTubeUrl(url), { videoId: ID, url: CANONICAL }, url);
  }
});

test('format: other hosts, other paths, bad ids and non-links are refused', () => {
  for (const url of [
    '', '   ', 'not a link', ID, `youtu.be/${ID}`, `ftp://youtu.be/${ID}`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}`, `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=dQw4w9WgXc!`, 'https://www.youtube.com/watch',
    `https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/channel/${ID}`,
    `https://www.youtube.com/playlist?list=${ID}`, `https://youtu.be/`,
    `https://evil.example/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`, `https://user@youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`, `https://www.youtube.com/shorts/${ID}/extra`,
    `https://www.youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`,
    `https://youtu.be/${'a'.repeat(300)}`, null, undefined, 42, { url: CANONICAL },
  ]) {
    assert.equal(yt.parseYouTubeUrl(url), null, String(url));
  }
});

// A stand-in for fetch that records the request and returns one response.
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (status instanceof Error) throw status;
    return { status, ok: status >= 200 && status < 300, json: async () => (typeof body === 'function' ? body() : body) };
  };
  fn.calls = calls;
  return fn;
}

const GOOD = { title: 'Liquid run', thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, type: 'video' };

test('oEmbed: a viewable video gives its title and thumbnail', async () => {
  const fetch = fakeFetch(200, GOOD);
  assert.deepEqual(await yt.checkVideo(ID, { fetch }), {
    ok: true, title: 'Liquid run', thumbnail: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
  });
  const asked = new URL(fetch.calls[0].url);
  assert.equal(asked.origin + asked.pathname, 'https://www.youtube.com/oembed');
  assert.equal(asked.searchParams.get('url'), CANONICAL);
  assert.equal(asked.searchParams.get('format'), 'json');
  assert.ok(fetch.calls[0].opts.signal, 'the request has a timeout');
  assert.equal(fetch.calls[0].opts.redirect, 'error');
});

test('oEmbed: private, deleted, embedding disabled or unknown all count as dead', async () => {
  for (const status of [400, 401, 403, 404]) {
    assert.deepEqual(await yt.checkVideo(ID, { fetch: fakeFetch(status, {}) }), { ok: false, reason: 'dead' }, String(status));
  }
});

test('oEmbed: no answer, a timeout, a server error or a bad body is "unreachable", never saved', async () => {
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  for (const fetch of [
    fakeFetch(new TypeError('fetch failed')), fakeFetch(timeout), fakeFetch(500, {}), fakeFetch(503, {}),
    fakeFetch(429, {}), fakeFetch(200, () => { throw new SyntaxError('bad json'); }), fakeFetch(200, null),
    fakeFetch(200, { thumbnail_url: GOOD.thumbnail_url }), fakeFetch(200, { title: '', thumbnail_url: GOOD.thumbnail_url }),
  ]) {
    assert.deepEqual(await yt.checkVideo(ID, { fetch }), { ok: false, reason: 'unreachable' });
  }
});

test('oEmbed: a thumbnail off i.ytimg.com is dropped; a long title is cut to 200 characters', async () => {
  const r = await yt.checkVideo(ID, { fetch: fakeFetch(200, { title: 'x'.repeat(500), thumbnail_url: 'https://evil.example/t.jpg' }) });
  assert.equal(r.ok, true);
  assert.equal(r.thumbnail, null);
  assert.equal(r.title.length, 200);
  const http = await yt.checkVideo(ID, { fetch: fakeFetch(200, { title: 't', thumbnail_url: `http://i.ytimg.com/vi/${ID}/hqdefault.jpg` }) });
  assert.equal(http.thumbnail, null);
});

test('oEmbed: refuses to ask about anything but a valid id', async () => {
  const fetch = fakeFetch(200, GOOD);
  await assert.rejects(yt.checkVideo('nope', { fetch }), /video id/);
  assert.equal(fetch.calls.length, 0);
});
