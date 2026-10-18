// Importer tests with a fake memory card
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const root = process.cwd();
const imp = require(root + '/lib/importer');
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`); };

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-ud-'));
  const card = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-card-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-dest-'));
  imp.init(() => {}, ud);
  const dcim = path.join(card, 'DCIM', '100GOPRO');
  fs.mkdirSync(dcim, { recursive: true });
  const day1 = new Date(2026, 9, 12, 14, 30), day2 = new Date(2026, 9, 14, 9, 5);
  const mk = (name, bytes, when) => { const p = path.join(dcim, name); fs.writeFileSync(p, bytes); fs.utimesSync(p, when, when); return p; };
  mk('GX010001.MP4', crypto.randomBytes(3e6), day1);
  mk('GX010002.MP4', crypto.randomBytes(2e6), day1);
  mk('GOPR0003.JPG', crypto.randomBytes(4e5), day2);
  mk('GX010001.LRV', crypto.randomBytes(1e5), day1);   // GoPro proxy: skipped
  mk('GX010001.THM', crypto.randomBytes(1e4), day1);   // thumbnail: skipped
  fs.writeFileSync(path.join(card, 'DCIM', 'notes.txt'), 'hello');

  let s = imp.scan(card);
  check('scan finds the media, not proxies/thumbnails', s.total === 3 && s.newCount === 3 && s.files.every((f) => !/\.(lrv|thm|txt)$/i.test(f.name)), s.files.map((f) => f.name).join(','));
  const progress = [];
  let r = await imp.run('a', { files: s.files, dest }, (p) => progress.push(p));
  const d1 = path.join(dest, '2026-10-12'), d2 = path.join(dest, '2026-10-14');
  const same = (a, b) => crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex') === crypto.createHash('sha1').update(fs.readFileSync(b)).digest('hex');
  check('copied into a folder per day', fs.existsSync(path.join(d1, 'GX010001.MP4')) && fs.existsSync(path.join(d1, 'GX010002.MP4')) && fs.existsSync(path.join(d2, 'GOPR0003.JPG')));
  check('copies are identical', same(path.join(dcim, 'GX010001.MP4'), path.join(d1, 'GX010001.MP4')) && same(path.join(dcim, 'GOPR0003.JPG'), path.join(d2, 'GOPR0003.JPG')));
  check('dates kept', Math.abs(fs.statSync(path.join(d1, 'GX010001.MP4')).mtimeMs - day1.getTime()) < 2000);
  check('result + progress', r.imported.length === 3 && !r.failed.length && progress.length > 0 && progress.at(-1).fraction > 0.99, `${progress.length} progress events`);
  check('card untouched', fs.readdirSync(dcim).length === 5);
  check('no leftover partial files', !fs.readdirSync(d1).some((n) => n.endsWith('.importing')));

  s = imp.scan(card);
  check('next time: nothing new', s.newCount === 0 && s.files.every((f) => f.imported));
  // a new clip on the card
  mk('GX010004.MP4', crypto.randomBytes(1e6), day2);
  s = imp.scan(card);
  check('only the new clip is new', s.newCount === 1 && s.files.find((f) => !f.imported).name === 'GX010004.MP4');
  // a different file with a name that's already taken gets a new name; the same file is skipped
  fs.writeFileSync(path.join(d2, 'GX010004.MP4'), crypto.randomBytes(500));
  r = await imp.run('b', { files: s.files.filter((f) => !f.imported), dest });
  check('name clash -> "(2)"', r.imported.length === 1 && /GX010004 \(2\)\.MP4$/.test(r.imported[0]), path.basename(r.imported[0] || ''));
  r = await imp.run('c', { files: imp.scan(card).files.slice(0, 1), dest });
  check('same file already there -> skipped', r.skipped === 1 && r.imported.length === 0);

  // cancel a big copy: nothing half-written stays
  const big = mk('GX019999.MP4', Buffer.alloc(300e6, 7), day2);
  const pr = imp.run('d', { files: [{ path: big, name: 'GX019999.MP4', size: 300e6, mtime: day2.getTime() }], dest });
  await new Promise((x) => setTimeout(x, 150));
  imp.cancel('d');
  r = await pr;
  check('cancel', r.cancelled && !r.imported.length && !fs.existsSync(path.join(d2, 'GX019999.MP4')) && !fs.readdirSync(d2).some((n) => n.endsWith('.importing')));

  // the index survives a restart
  imp.init(() => {}, ud);
  check('remembers imports after a restart', imp.scan(card).files.filter((f) => f.imported).length >= 4);

  const rem = await imp.removableInfo();
  console.log('   removable drives right now: ' + (rem.map((d) => d.root + ' ' + d.label).join(', ') || 'none'));
  for (const d of [ud, card, dest]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
