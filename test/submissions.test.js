// F-C3 Submit videos: S-B5, the S-B2 battle status card, the S-M1 action item.
// Permission rules are checked on the server; these tests call the routes
// directly, the way a crafted request would. YouTube is a stand-in: the
// routes call youtube.checkVideo through the module, and tests replace it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, HOST } = require('../index');
const { pool } = require('../db');
const youtube = require('../lib/youtube');
const { hashPassword } = require('../lib/passwords');
const { encryptDob, parseKey } = require('../lib/dob-crypto');
const { Browser, listen } = require('./helpers/http');
const { clearBattles } = require('./helpers/db');

const PASSWORD = 'a long passphrase';
const realCheck = youtube.checkVideo;

let server;
let base;
let hash;
const ids = {};
let checks; // video ids the stand-in was asked about
let answers; // video id -> checkVideo result

const vid = (n) => `vid${n}`.padEnd(11, 'x');
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const good = (id, title = `Run ${id}`) => ({ ok: true, title, thumbnail: thumb(id) });

before(async () => {
  ({ server, base } = await listen(app, HOST));
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  ids.alice = await addUser('Alice');
  ids.bob = await addUser('Bob');
  ids.carol = await addUser('Carol');
  checks = [];
  answers = new Map();
  youtube.checkVideo = async (id) => {
    checks.push(id);
    return answers.get(id) || good(id);
  };
});

after(async () => {
  youtube.checkVideo = realCheck;
  await new Promise((resolve) => server.close(resolve));
  await clearBattles(pool);
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM session');
  await pool.end();
});

async function addUser(username) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (username, email, password_hash, dob_encrypted, age_gate_passed, terms_accepted_at,
                        status, email_verified_at)
     VALUES ($1, $2, $3, $4, true, now(), 'active', now()) RETURNING id`,
    [username, `${username.toLowerCase()}@example.com`, hash, encryptDob('2000-01-01', parseKey(process.env.DOB_ENC_KEY))],
  );
  return u.id;
}

async function as(username) {
  const b = new Browser(base);
  const token = await b.csrfFrom('/login');
  const r = await b.post('/login', { identifier: username, password: PASSWORD, _csrf: token });
  assert.equal(r.status, 303, `login ${username}`);
  b.token = await b.csrfFrom('/dashboard');
  return b;
}

// An accepted 1v1 battle with its slot, videos due in `hours`.
async function battle(from = 'alice', to = 'bob', hours = 120) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days,
                          status, accepted_at, submissions_due_at)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5, 'accepted', now() - interval '120 hours' + make_interval(hours => $3),
             now() + make_interval(hours => $3)) RETURNING id`,
    [ids[from], ids[to], hours],
  );
  await pool.query(
    'INSERT INTO battle_slots (battle_id, position, challenger_user_id, opponent_user_id) VALUES ($1, 1, $2, $3)',
    [b.id, ids[from], ids[to]],
  );
  return b.id;
}

const page = (id) => `/battles/${id}/video`;
const checkedFrom = (html) => (/name="checked" value="([^"]*)"/.exec(html) || [])[1];

// Check link, then Submit with what was checked, the way the form does.
async function submit(b, id, videoId) {
  const c = await b.post(`${page(id)}/check`, { youtube_url: `https://youtu.be/${videoId}`, _csrf: b.token });
  return b.post(page(id), { youtube_url: `https://youtu.be/${videoId}`, checked: checkedFrom(c.html) || '', _csrf: b.token });
}
const direct = (b, id, videoId) => b.post(page(id), { youtube_url: watch(videoId), checked: videoId, _csrf: b.token });
const cancel = (b, id) => b.post(`${page(id)}/cancel`, { _csrf: b.token });

const rows = async (where = 'true', params = []) => (await pool.query(
  `SELECT s.*, u.username FROM submissions s JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY submitted_at, id`, params,
)).rows;
const live = (who) => rows("s.user_id = $1 AND s.status IN ('submitted', 'dead_link')", [ids[who]]);

// --- Permissions ---

test('logged-out visitors are sent to log in and nothing is saved', async () => {
  const id = await battle();
  const v = new Browser(base);
  const r = await v.get(page(id));
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login');
  const token = await v.csrfFrom('/login');
  for (const p of [page(id), `${page(id)}/check`, `${page(id)}/cancel`]) {
    const x = await v.post(p, { youtube_url: watch(vid(1)), checked: vid(1), _csrf: token });
    assert.equal(x.status, 302, p);
    assert.equal(x.location, '/login', p);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(checks.length, 0);
});

test('a stranger gets 404 everywhere, nothing is saved and YouTube is never asked', async () => {
  const id = await battle();
  const c = await as('Carol');
  assert.equal((await c.get(page(id))).status, 404);
  assert.equal((await c.post(`${page(id)}/check`, { youtube_url: watch(vid(1)), _csrf: c.token })).status, 404);
  assert.equal((await direct(c, id, vid(1))).status, 404);
  assert.equal((await cancel(c, id)).status, 404);
  assert.equal((await c.get(page('not-a-uuid'))).status, 404);
  assert.equal((await c.get(page('00000000-0000-0000-0000-000000000000'))).status, 404);
  assert.equal((await rows()).length, 0);
  assert.equal(checks.length, 0);
});

test('a player always submits as themselves; user and slot fields in the form are ignored', async () => {
  const id = await battle();
  const a = await as('Alice');
  const r = await a.post(page(id), {
    youtube_url: watch(vid(1)), checked: vid(1), user_id: ids.bob, slot_id: 'x', _csrf: a.token,
  });
  assert.equal(r.status, 303);
  const [s] = await rows();
  assert.equal(s.user_id, ids.alice);
  assert.equal((await live('bob')).length, 0);
});

test('forms never carry a submission id', async () => {
  const id = await battle();
  const a = await as('Alice');
  await direct(a, id, vid(1));
  const [s] = await rows();
  const html = (await a.get(page(id))).html;
  assert.ok(!html.includes(s.id));
  assert.ok(!html.includes(s.slot_id));
});

test('a call out that was never accepted has no videos to submit', async () => {
  const { rows: [b] } = await pool.query(
    `INSERT INTO battles (kind, scoring, judging, challenger_user_id, opponent_user_id, created_by, submission_days)
     VALUES ('single', 'fun', 'official', $1, $2, $1, 5) RETURNING id`, [ids.alice, ids.bob],
  );
  const a = await as('Alice');
  const r = await direct(a, b.id, vid(1));
  assert.equal(r.status, 409);
  assert.match(r.html, /Videos open once the call out is accepted\./);
  assert.equal((await rows()).length, 0);
  assert.equal(checks.length, 0);
});

test('after the due date nothing can be submitted, replaced or cancelled, and YouTube is not asked', async () => {
  const id = await battle();
  const a = await as('Alice');
  assert.equal((await direct(a, id, vid(1))).status, 303);
  checks.length = 0;
  await pool.query("UPDATE battles SET submissions_due_at = now() - interval '1 minute', accepted_at = now() - interval '120 hours 1 minute' WHERE id = $1", [id]);
  const bob = await as('Bob');
  for (const [who, r] of [[bob, await direct(bob, id, vid(2))], [a, await direct(a, id, vid(3))], [a, await cancel(a, id)]]) {
    assert.equal(r.status, 409);
    assert.match(r.html, /The due date has passed\./);
    assert.ok(who);
  }
  const check = await bob.post(`${page(id)}/check`, { youtube_url: watch(vid(2)), _csrf: bob.token });
  assert.equal(check.status, 409);
  assert.equal(checks.length, 0);
  const all = await rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'submitted');
});

// --- Link check ---

test('a link that is not a YouTube watch, youtu.be or shorts link is refused before YouTube is asked', async () => {
  const id = await battle();
  const a = await as('Alice');
  for (const p of [`${page(id)}/check`, page(id)]) {
    const r = await a.post(p, { youtube_url: 'https://vimeo.com/123', checked: '', _csrf: a.token });
    assert.equal(r.status, 400, p);
    assert.match(r.html, /Paste a YouTube link/, p);
  }
  assert.equal(checks.length, 0);
  assert.equal((await rows()).length, 0);
});

test('a private, deleted or embedding-disabled video is refused', async () => {
  const id = await battle();
  answers.set(vid(1), { ok: false, reason: 'dead' });
  const a = await as('Alice');
  for (const p of [`${page(id)}/check`, page(id)]) {
    const r = await a.post(p, { youtube_url: watch(vid(1)), checked: vid(1), _csrf: a.token });
    assert.equal(r.status, 400, p);
    assert.match(r.html, /private, deleted, or embedding is turned off/, p);
  }
  assert.equal((await rows()).length, 0);
});

test('if YouTube cannot be reached the video is refused, never saved unchecked', async () => {
  const id = await battle();
  answers.set(vid(1), { ok: false, reason: 'unreachable' });
  const a = await as('Alice');
  for (const p of [`${page(id)}/check`, page(id)]) {
    const r = await a.post(p, { youtube_url: watch(vid(1)), checked: vid(1), _csrf: a.token });
    assert.equal(r.status, 503, p);
    assert.match(r.html, /Couldn&#39;t check the video, try again\./, p);
  }
  assert.equal((await rows()).length, 0);
});

test('Check link shows the title and thumbnail and saves nothing', async () => {
  const id = await battle();
  const a = await as('Alice');
  const r = await a.post(`${page(id)}/check`, { youtube_url: `https://youtube.com/shorts/${vid(1)}`, _csrf: a.token });
  assert.equal(r.status, 200);
  assert.match(r.html, new RegExp(`Run ${vid(1)}`));
  assert.ok(r.html.includes(`src="${thumb(vid(1))}"`));
  assert.match(r.html, /Link works/);
  assert.equal(checkedFrom(r.html), vid(1));
  assert.match(r.html, /Submit video/);
  assert.equal((await rows()).length, 0);
});

test('Submit saves the canonical link and the snapshots from YouTube, never from the form', async () => {
  const id = await battle();
  const a = await as('Alice');
  const r = await a.post(page(id), {
    youtube_url: `https://youtu.be/${vid(1)}?si=x`, checked: vid(1), title_snapshot: 'evil', thumbnail_snapshot: 'https://evil.example/x.jpg', _csrf: a.token,
  });
  assert.equal(r.status, 303);
  assert.equal(r.location, page(id));
  const [s] = await rows();
  assert.equal(s.youtube_url, watch(vid(1)));
  assert.equal(s.video_id, vid(1));
  assert.equal(s.title_snapshot, `Run ${vid(1)}`);
  assert.equal(s.thumbnail_snapshot, thumb(vid(1)));
  assert.equal(s.status, 'submitted');
  assert.equal(s.locked_at, null);
  assert.deepEqual(checks, [vid(1)]); // checked again on Submit
});

test('a link changed after Check is not saved; the new one is shown for checking', async () => {
  const id = await battle();
  const a = await as('Alice');
  const r = await a.post(page(id), { youtube_url: watch(vid(2)), checked: vid(1), _csrf: a.token });
  assert.equal(r.status, 400);
  assert.match(r.html, /You changed the link after Check/);
  assert.equal(checkedFrom(r.html), vid(2));
  const missing = await a.post(page(id), { youtube_url: watch(vid(2)), _csrf: a.token });
  assert.equal(missing.status, 400);
  assert.equal((await rows()).length, 0);
});

// --- Replace and cancel (before the lock) ---

test('replace keeps the old video as history and makes the new one live', async () => {
  const id = await battle();
  const a = await as('Alice');
  await submit(a, id, vid(1));
  const r = await submit(a, id, vid(2));
  assert.equal(r.status, 303);
  const all = await rows();
  assert.deepEqual(all.map((s) => [s.video_id, s.status]), [[vid(1), 'replaced'], [vid(2), 'submitted']]);
});

test('cancel withdraws the video; the slot is empty and the player can submit again', async () => {
  const id = await battle();
  const a = await as('Alice');
  await submit(a, id, vid(1));
  assert.equal((await cancel(a, id)).status, 303);
  assert.equal((await live('alice')).length, 0);
  assert.match((await a.get(page(id))).html, /Not submitted/);
  const again = await cancel(a, id); // a repeat of her own cancel just shows the page
  assert.equal(again.status, 303);
  assert.equal(again.location, page(id));
  assert.equal((await submit(a, id, vid(2))).status, 303);
  assert.deepEqual((await rows()).map((s) => s.status), ['cancelled', 'submitted']);
});

test('double-clicking Submit saves one video and both clicks land on the page', async () => {
  const id = await battle();
  const a = await as('Alice');
  const [r1, r2] = await Promise.all([direct(a, id, vid(1)), direct(a, id, vid(1))]);
  assert.equal(r1.status, 303);
  assert.equal(r2.status, 303);
  assert.equal((await rows()).length, 1);
});

// --- Lock at the second video ---

test('the second video locks both submissions, and the first player can still have been alone', async () => {
  const id = await battle();
  const a = await as('Alice');
  const b = await as('Bob');
  await submit(a, id, vid(1));
  assert.equal((await live('alice'))[0].locked_at, null);
  assert.equal((await submit(b, id, vid(2))).status, 303); // Bob had not submitted: he still can
  const [sa] = await live('alice');
  const [sb] = await live('bob');
  assert.ok(sa.locked_at);
  assert.ok(sb.locked_at);
  assert.equal(sa.locked_at.getTime(), sb.locked_at.getTime());
});

test('two players submitting at the same moment both end up locked exactly once', async () => {
  for (let i = 0; i < 6; i += 1) {
    await clearBattles(pool);
    const id = await battle();
    const a = await as('Alice');
    const b = await as('Bob');
    const [ra, rb] = await Promise.all([direct(a, id, vid(1)), direct(b, id, vid(2))]);
    assert.deepEqual([ra.status, rb.status], [303, 303], `round ${i}`);
    const all = await rows();
    assert.equal(all.length, 2, `round ${i}`);
    assert.ok(all.every((s) => s.status === 'submitted' && s.locked_at), `round ${i}: both locked`);
    assert.equal(all[0].locked_at.getTime(), all[1].locked_at.getTime(), `round ${i}: one lock`);
  }
});

test('after the lock, replace and cancel are refused and nothing changes', async () => {
  const id = await battle();
  const a = await as('Alice');
  const b = await as('Bob');
  await submit(a, id, vid(1));
  await submit(b, id, vid(2));
  const before = await rows();
  checks.length = 0;
  for (const [who, r] of [[a, await direct(a, id, vid(3))], [b, await cancel(b, id)], [a, await cancel(a, id)]]) {
    assert.equal(r.status, 409);
    assert.match(r.html, /Both videos are in, so submissions are locked\./);
    assert.ok(who);
  }
  const check = await a.post(`${page(id)}/check`, { youtube_url: watch(vid(3)), _csrf: a.token });
  assert.equal(check.status, 409);
  assert.equal(checks.length, 0);
  assert.deepEqual(await rows(), before);
  assert.doesNotMatch((await a.get(page(id))).html, /Replace video|Cancel submission|name="youtube_url"/);
});

// --- Opponent's video hidden until both are in or the due date passes ---

test('before both are in, the opponent sees only "Submitted": no title, link or thumbnail', async () => {
  const id = await battle();
  const a = await as('Alice');
  await submit(a, id, vid(1), 'Secret run');
  answers.set(vid(1), good(vid(1), 'Secret run'));
  await submit(a, id, vid(1)); // same video again: no change, still one live row
  const b = await as('Bob');
  for (const p of [page(id), `/callouts/${id}`, '/dashboard', '/my-battles?tab=active']) {
    const html = (await b.get(p)).html;
    assert.ok(!html.includes(vid(1)), `${p}: video id`);
    assert.doesNotMatch(html, /Run vid1|Secret run/, `${p}: title`);
  }
  assert.match((await b.get(page(id))).html, /Alice<\/dt><dd><span class="pill[^"]*">Submitted/);
});

test('once both are in, both players see both videos', async () => {
  const id = await battle();
  const a = await as('Alice');
  const b = await as('Bob');
  await submit(a, id, vid(1));
  await submit(b, id, vid(2));
  for (const who of [a, b]) {
    for (const p of [page(id), `/callouts/${id}`]) {
      const html = (await who.get(p)).html;
      assert.ok(html.includes(watch(vid(1))) && html.includes(watch(vid(2))), p);
      assert.ok(html.includes(`src="${thumb(vid(1))}"`) && html.includes(`src="${thumb(vid(2))}"`), p);
    }
  }
});

test('after the due date, a video submitted alone is shown to the opponent', async () => {
  const id = await battle();
  const a = await as('Alice');
  await submit(a, id, vid(1));
  await pool.query("UPDATE battles SET submissions_due_at = now() - interval '1 minute', accepted_at = now() - interval '120 hours 1 minute' WHERE id = $1", [id]);
  const html = (await (await as('Bob')).get(page(id))).html;
  assert.ok(html.includes(watch(vid(1))));
});

// --- Where players find it ---

test('the dashboard lists "Submit your video" until the player has submitted', async () => {
  const id = await battle();
  const a = await as('Alice');
  const item = (html) => html.includes(`href="${page(id)}"`) && /Submit your video: You vs Bob/.test(html);
  assert.ok(item((await a.get('/dashboard')).html));
  await submit(a, id, vid(1));
  assert.ok(!item((await a.get('/dashboard')).html));
  assert.match((await (await as('Bob')).get('/dashboard')).html, /Submit your video: You vs Alice/);
});

test('the accepted call out page shows the battle status and a Submit video button', async () => {
  const id = await battle();
  const a = await as('Alice');
  const html = (await a.get(`/callouts/${id}`)).html;
  assert.match(html, /Battle status/);
  assert.match(html, /Your video<\/dt><dd><span class="pill[^"]*">Not submitted/);
  assert.ok(html.includes(`href="${page(id)}"`));
});

test('the CSP allows images from this site, data URLs and i.ytimg.com only', async () => {
  const r = await fetch(`${base}/health`);
  const img = r.headers.get('content-security-policy').split(';').find((d) => d.startsWith('img-src '));
  assert.equal(img, "img-src 'self' data: https://i.ytimg.com");
});

// Browser test, Nov 24: the sidebar kept saying videos could be replaced after the lock.
test('the Battle status hint about replacing shows only while the video can still change', async () => {
  const HINT = /You can replace your video until the due date/;
  const id = await battle();
  const a = await as('Alice');
  const b = await as('Bob');
  assert.match((await a.get(page(id))).html, HINT);
  await submit(a, id, vid(1));
  assert.match((await a.get(page(id))).html, HINT);
  await submit(b, id, vid(2));
  for (const who of [a, b]) {
    const html = (await who.get(page(id))).html;
    assert.doesNotMatch(html, HINT);
    assert.match(html, /Both videos are in\. Submissions are locked\./);
  }
  const late = await battle('carol', 'alice');
  await pool.query("UPDATE battles SET submissions_due_at = now() - interval '1 minute', accepted_at = now() - interval '120 hours 1 minute' WHERE id = $1", [late]);
  assert.doesNotMatch((await a.get(page(late))).html, HINT);
});
