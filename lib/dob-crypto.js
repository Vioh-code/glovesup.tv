// F-A1: date of birth is encrypted (not hashed) so age checks still work.
// AES-256-GCM. Stored layout (bytea):
//   [1 byte version = 1][12 bytes random IV][16 bytes auth tag][ciphertext of "YYYY-MM-DD"]
// The version byte is also bound in as additional authenticated data, so it
// cannot be changed without failing decryption. A future key rotation adds
// version 2 with a new key and keeps decrypting version 1 until rows are rewritten.
//
// The key is DOB_ENC_KEY: base64 of 32 random bytes. It lives only in the env
// file and a separate backup. A database dump holds ciphertext only, so losing
// the key loses every stored DOB. Never log the key or a DOB.
const crypto = require('node:crypto');

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseKey(base64) {
  const key = typeof base64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    ? Buffer.from(base64, 'base64')
    : null;
  if (!key || key.length !== 32) {
    throw new Error('DOB_ENC_KEY must be base64 of exactly 32 bytes.');
  }
  return key;
}

function encryptDob(dob, key) {
  if (typeof dob !== 'string' || !DOB_RE.test(dob)) {
    throw new Error('encryptDob expects a YYYY-MM-DD string.');
  }
  const version = Buffer.from([VERSION]);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(version);
  const body = Buffer.concat([cipher.update(dob, 'utf8'), cipher.final()]);
  return Buffer.concat([version, iv, cipher.getAuthTag(), body]);
}

function decryptDob(box, key) {
  if (!Buffer.isBuffer(box) || box.length <= HEADER_BYTES) {
    throw new Error('Stored DOB is not a valid ciphertext.');
  }
  if (box[0] !== VERSION) throw new Error('Stored DOB has an unknown version.');
  const iv = box.subarray(1, 1 + IV_BYTES);
  const tag = box.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(box.subarray(0, 1));
  decipher.setAuthTag(tag);
  // final() throws if the key is wrong or any byte was changed.
  return Buffer.concat([decipher.update(box.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
}

module.exports = { parseKey, encryptDob, decryptDob };
