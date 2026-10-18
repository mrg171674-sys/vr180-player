// PIN for the private vault, stored only as a salted scrypt hash.
const crypto = require('crypto');
const store = require('./store');

const hash = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');

function hasPin() { return !!store.get().vault?.hash; }
function setPin(pin, oldPin) {
  if (hasPin() && !verify(oldPin)) return false;
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4 to 8 digits');
  const salt = crypto.randomBytes(16).toString('hex');
  store.set({ vault: { salt, hash: hash(pin, salt) } });
  return true;
}
function verify(pin) {
  const v = store.get().vault;
  if (!v?.hash) return false;
  const a = Buffer.from(hash(pin ?? '', v.salt), 'hex'), b = Buffer.from(v.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function clearPin(pin) {
  if (!verify(pin)) return false;
  store.set({ vault: null });
  return true;
}

module.exports = { hasPin, setPin, verify, clearPin };
