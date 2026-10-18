// Settings persisted as JSON in the app's userData folder.
const fs = require('fs');
const path = require('path');

let file, data = {}, timer;

function init(dir) {
  file = path.join(dir, 'settings.json');
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  return data;
}
const get = () => data;
function set(patch) {
  Object.assign(data, patch);
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
  return data;
}
function flush() {
  clearTimeout(timer);
  try { fs.writeFileSync(file, JSON.stringify(data, null, 1)); } catch (e) { console.error('settings save failed', e); }
}

// swap in a whole new set of settings (used by "Import settings")
function replace(next) {
  for (const k of Object.keys(data)) delete data[k];
  Object.assign(data, next);
  flush();
  return data;
}

module.exports = { init, get, set, flush, replace };
