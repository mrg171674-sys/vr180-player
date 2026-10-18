# VR180 Player tests

Run from the project folder. Always use a test profile (`VR180_PROFILE`) so your own settings are never touched.

**UI suites** (Electron): `CLIP=GOPR0042.mp4 VR180_PROFILE=test STEPS_FILE=scripts/tests/steps_regress.json node_modules/.bin/electron scripts/tests/selftest.js`
Each step prints `name => result`; screenshots go to %TEMP%\vr180-test-shots.

**Node suites:** `node scripts/tests/t_phone.js` (phone server), `t_phone2/3.js`, `t_backup.js`; the newer ones take the project folder as the first argument, e.g. `node scripts/tests/t_pair.js`, `node scripts/tests/t_import.js`, `node scripts/tests/t_together.js .`, `node scripts/tests/t_export6.js . <out-folder>`.

Some suites expect fixtures in %TEMP%\claude\vrt (e.g. talk.mp4, made from a speech sample) or %TEMP%\libtest; recreate them as the suite's setup describes.
Note: steps_v4a and steps_align save snapshots to Pictures\VR180 Player; delete them afterwards. steps_lib5 sends duplicates to the Recycle Bin: use steps_lib5b.json instead.

Building: NSIS can't handle this folder's long path. Copy the project (without dist and test-videos) to a short folder, run `npm run dist` there and copy dist back.
