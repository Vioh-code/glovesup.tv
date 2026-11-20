// F-A1, F-A2: password hashing with bcrypt, cost 12.
// bcrypt only reads the first 72 bytes, so longer input is refused rather than
// silently truncated (lib/validate.js enforces the same limit on the form).
// Never log a password or a hash.
const bcrypt = require('bcrypt');

const COST = 12;
const MAX_BYTES = 72;

// Hash of a random string nobody knows, made once with cost 12. Login compares
// against it when the username or email does not exist, so an unknown account
// takes the same time as a wrong password (F-A2, no account enumeration).
const DUMMY_HASH = '$2b$12$I1Jxu3q0H.BAP7YnPZ8Q7.K.Bs.JCzgA/eftiySLVrpDyfukzcxG2';

const usable = (password) => typeof password === 'string'
  && Buffer.byteLength(password, 'utf8') <= MAX_BYTES;

async function hashPassword(password) {
  if (!usable(password)) throw new Error('Password must be a string of at most 72 bytes.');
  return bcrypt.hash(password, COST);
}

async function verifyPassword(password, hash) {
  if (typeof hash !== 'string' || !hash) {
    await dummyVerify(password);
    return false;
  }
  if (!usable(password)) {
    await dummyVerify('');
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false; // malformed stored hash: treat as a failed login
  }
}

async function dummyVerify(password) {
  await bcrypt.compare(usable(password) ? password : '', DUMMY_HASH);
  return false;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, COST };
