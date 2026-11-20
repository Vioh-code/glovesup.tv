// F-A1 input rules (decided Nov 17, 2026; see 01-feature-spec, F-A1 and F-A2).
// Pure functions. Never log the values passed in: they include passwords and DOBs.

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything past 72 bytes
const MIN_AGE = 13;

const isString = (s) => typeof s === 'string';

function usernameError(username) {
  if (!isString(username) || !USERNAME_RE.test(username)) {
    return 'Username must be 3 to 20 letters, numbers, _ or -.';
  }
  return null;
}

function emailError(email) {
  if (!isString(email) || email.length > 254 || !EMAIL_RE.test(email)) {
    return 'Enter a valid email address.';
  }
  return null;
}

function passwordError(password, { username, email } = {}) {
  if (!isString(password)) return 'Enter a password.';
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN_BYTES) return 'Password must be at least 12 characters.';
  if (bytes > PASSWORD_MAX_BYTES) return 'Password is too long (72 bytes at most).';
  const lower = password.toLowerCase();
  if ((isString(username) && lower === username.toLowerCase())
      || (isString(email) && lower === email.toLowerCase())) {
    return 'Password cannot be your username or email.';
  }
  return null;
}

// Returns { year, month, day } for a real calendar date between 1900 and today, else null.
// `today` is a Date; its UTC calendar date is "the day of signup".
function parseDob(dob, today) {
  if (!isString(dob)) return null;
  const m = DOB_RE.exec(dob);
  if (!m) return null;
  const [year, month, day] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null; // e.g. Feb 30 rolled over
  }
  if (year < 1900 || d > utcDay(today)) return null;
  return { year, month, day };
}

function utcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// True when the 13th birthday is on or before today (UTC calendar date).
// A Feb 29 birthday rolls to Mar 1 in non-leap years (Date.UTC rolls over).
function isAtLeast13(dob, today) {
  const p = parseDob(dob, today);
  if (!p) return false;
  const birthday13 = new Date(Date.UTC(p.year + MIN_AGE, p.month - 1, p.day));
  return birthday13 <= utcDay(today);
}

// Validates the S-P8 form. Returns:
//   errors    list of messages for the form (empty when valid)
//   underAge  true when the DOB is valid but under 13 (caller writes nothing)
//   values    cleaned values to store (only meaningful when errors is empty)
//   redisplay values safe to put back in the form (never password or DOB)
function validateRegistration(body, today) {
  const username = isString(body.username) ? body.username.trim() : body.username;
  const email = isString(body.email) ? body.email.trim() : body.email;
  const { dob, password } = body;
  const redisplay = {
    username: isString(username) ? username : '',
    email: isString(email) ? email : '',
  };

  if (parseDob(dob, today) && !isAtLeast13(dob, today)) {
    return { errors: ['You must be 13 or older to join.'], underAge: true, values: null, redisplay };
  }

  const errors = [
    usernameError(username),
    emailError(email),
    parseDob(dob, today) ? null : 'Enter a valid date of birth.',
    passwordError(password, { username, email }),
    password === body.password_confirm ? null : 'Passwords do not match.',
    body.terms === 'yes' ? null : 'You must agree to the Terms and Privacy Policy.',
  ].filter(Boolean);

  return { errors, underAge: false, values: { username, email, dob, password }, redisplay };
}

module.exports = {
  usernameError,
  emailError,
  passwordError,
  parseDob,
  isAtLeast13,
  validateRegistration,
};
