// Secrets the app needs before it may start (F-A1, F-A2).
// Errors name the variable, never its value.
const { parseKey } = require('./dob-crypto');

const MIN_SECRET_CHARS = 32;

function loadConfig(env) {
  const problems = [];

  const sessionSecret = env.SESSION_SECRET;
  if (typeof sessionSecret !== 'string' || sessionSecret.length < MIN_SECRET_CHARS) {
    problems.push(`SESSION_SECRET must be set, at least ${MIN_SECRET_CHARS} characters`);
  }

  let dobKey = null;
  try {
    dobKey = parseKey(env.DOB_ENC_KEY);
  } catch {
    problems.push('DOB_ENC_KEY must be set, base64 of exactly 32 bytes');
  }

  if (problems.length) throw new Error(`${problems.join('; ')}.`);

  return { sessionSecret, dobKey, isProduction: env.NODE_ENV === 'production' };
}

module.exports = { loadConfig };
