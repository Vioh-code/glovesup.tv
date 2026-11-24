// F-C1, F-C2 call out rules (01-feature-spec, F-C1, F-C2 and Business rules).
// Pure functions. The database enforces the same rules again (battles CHECKs).
const { LABELS } = require('./labels');

const ELO_BAND = 400;
const DUE_DAYS = ['3', '5', '7'];
const SCORING = Object.keys(LABELS.scoring);
const JUDGING = Object.keys(LABELS.judging);
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

const HOUR = 3600 * 1000;

// ELO call outs: opponent within 400 above or below, inclusive.
function withinEloBand(myRating, theirRating) {
  return Math.abs(myRating - theirRating) <= ELO_BAND;
}

// Value for battles.elo_band_ok: null on Just for fun, where the band does not apply.
function eloBandOk(scoring, myRating, theirRating) {
  return scoring === 'elo' ? withinEloBand(myRating, theirRating) : null;
}

const pick = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : '');

// Returns { errors, values, redisplay }. values is only meaningful with no errors.
// In slice 2a only Single (1v1) is open; teams come with the teams slice.
function parseCalloutForm(body = {}) {
  const errors = [];
  const opponent = typeof body.opponent === 'string' ? body.opponent.trim() : '';
  const scoring = pick(body.scoring, SCORING);
  const judging = pick(body.judging, JUDGING);
  const days = pick(body.submission_days, DUE_DAYS);

  if (!USERNAME_RE.test(opponent)) errors.push("Enter your opponent's username.");
  if (body.format === 'team') errors.push('Team call outs open once teams are available.');
  if (!scoring) errors.push('Pick ELO or Just for fun.');
  if (!judging) errors.push('Pick Official judges or Popular vote.');
  if (scoring === 'elo' && judging === 'popular') errors.push('ELO battles must use official judges.');
  if (!days) errors.push('Pick 3, 5 or 7 days.');

  return {
    errors,
    values: { opponent, kind: 'single', scoring, judging, submission_days: Number(days) },
    redisplay: { opponent: USERNAME_RE.test(opponent) ? opponent : '', scoring, judging, submission_days: days },
  };
}

// Countdown shared element (05-screen-inventory): whole days (rounded down)
// from 48 hours out, whole hours below that, "Less than 1 hour" under an hour,
// urgent in the last 24 hours (inclusive).
function timeLeft(due, now = new Date()) {
  const ms = due.getTime() - now.getTime();
  if (ms <= 0) return { expired: true, text: 'Time is up', urgent: false };
  const urgent = ms <= 24 * HOUR;
  let text;
  if (ms >= 48 * HOUR) {
    const d = Math.floor(ms / (24 * HOUR));
    text = `${d} days left`;
  } else if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR);
    text = `${h} ${h === 1 ? 'hour' : 'hours'} left`;
  } else {
    text = 'Less than 1 hour left';
  }
  return { expired: false, text, urgent };
}

// The terms the Review card showed, as one string. Send and Save changes must
// carry it back unchanged, so a field edited after Review is never sent unseen.
const reviewKey = (v) => [String(v.opponent).toLowerCase(), v.scoring, v.judging, String(v.submission_days)].join('|');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

// A date's no-JavaScript text, in UTC and labelled so, e.g. "Nov 27, 22:54 UTC".
// public/js/local-time.js replaces it with the viewer's own time zone.
const utcText = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;

module.exports = { ELO_BAND, DUE_DAYS, withinEloBand, eloBandOk, parseCalloutForm, timeLeft, utcText, reviewKey };
