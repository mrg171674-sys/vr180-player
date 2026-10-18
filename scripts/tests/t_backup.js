const b = require(process.cwd() + '/lib/backup');
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
const lut = path.join(dir, 'myfilm.cube');
fs.writeFileSync(lut, 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const A = 'd:\\videos\\a.mp4', X = 'd:\\secret\\x.mp4';
const s = {
  theme: 'ocean', vaultOn: true, phonePin: '1234', keymap: { play: ['P'] },
  folders: [{ path: 'D:\\Videos', private: false }, { path: 'D:\\Secret', private: true }],
  meta: { [A]: { fav: true, tags: ['Beach'] }, [X]: { fav: true } },
  resume: { [A]: { t: 30, d: 60, at: 1 }, [X]: { t: 5, d: 9, at: 1 } },
  picturePresets: [{ name: 'Film', brightness: 0, contrast: 110, saturation: 90, lut }],
  calib: { [A]: { lut } }, recent: ['D:\\Videos\\a.mp4', 'D:\\Secret\\x.mp4']
};
let pass = 0, fail = 0;
const check = (l, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };

const bk = b.build(s, '1.0.0');
const txt = JSON.stringify(bk);
check('vault switch and phone PIN left out', !('vaultOn' in bk.settings) && !('phonePin' in bk.settings) && !txt.includes('1234'));
check('private folder and everything in it left out', bk.settings.folders.length === 1 && Object.keys(bk.settings.meta).length === 1 && Object.keys(bk.settings.resume).length === 1 && bk.settings.recent.length === 1 && !txt.toLowerCase().includes('secret'));
check('custom LUT file embedded', Object.keys(bk.luts).length === 1);
console.log('      summary:', JSON.stringify(b.summarize(b.parse(txt))));

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'bkud-'));
const fresh = { theme: 'midnight', phonePin: '9999', folders: [{ path: 'E:\\Mine', private: true }] };
const r = b.apply(b.parse(txt), fresh, 'replace', ud);
const newLut = r.picturePresets[0].lut;
check('replace: settings restored', r.theme === 'ocean' && r.keymap.play[0] === 'P' && r.meta[A].tags[0] === 'Beach' && r.resume[A].t === 30);
check('replace: this PC\'s PIN and private folder kept', r.phonePin === '9999' && r.folders.some((f) => f.path === 'E:\\Mine' && f.private));
check('LUT restored into this PC\'s app folder, settings point at it', newLut.startsWith(ud) && fs.readFileSync(newLut, 'utf8') === fs.readFileSync(lut, 'utf8') && r.calib[A].lut === newLut, path.relative(ud, newLut));

const m = b.apply(b.parse(txt), { theme: 'forest', keymap: { mute: ['X'] }, picturePresets: [{ name: 'Mine' }] }, 'merge', ud);
check('merge keeps your own extras', m.keymap.mute[0] === 'X' && m.keymap.play[0] === 'P' && m.picturePresets.map((p) => p.name).join(',') === 'Mine,Film');
let rejected = false;
try { b.parse('{"hello":1}'); } catch (e) { rejected = /isn't a VR180 Player backup/.test(e.message); }
check('a random file is rejected', rejected);
console.log(`\n${pass} passed, ${fail} failed`);
