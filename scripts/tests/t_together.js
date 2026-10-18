// Watch Together v2: room code, challenge-response, encryption, approval, message filtering
const { fork } = require('child_process');
const net = require('net');
const ROOT = process.argv[2];
const T = require(ROOT + '/lib/together.js');
let pass = 0, fail = 0;
const check = (l, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[3] === 'member') {
  // child: join and report what happens
  const events = [];
  const M = require(ROOT + '/lib/together.js');
  M.init((ch, d) => { events.push([ch, d]); process.send({ ch, d }); });
  M.join('127.0.0.1', process.argv[5], process.argv[4]).then((s) => process.send({ joined: s.waiting ? 'waiting' : 'ok' }), (e) => process.send({ error: e.message }));
  process.on('message', (m) => { if (m.send) M.send(m.send); if (m.leave) { M.leave(); process.exit(0); } });
  return;
}

(async () => {
  const events = [];
  T.init((ch, d) => events.push([ch, d]));
  const st = await T.host('Host PC', { approve: true, secret: 'XM4RT' });
  check('room has a 5-character code', st.secret === 'XM4RT');

  const member = (code, name) => {
    const c = fork(__filename, [ROOT, 'member', code, name], { silent: true });
    c.msgs = [];
    c.on('message', (m) => c.msgs.push(m));
    return c;
  };
  const until = async (c, pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) return m; await wait(50); } return null; };

  // wrong code
  const bad = member('AAAAA', 'Stranger');
  const r1 = await until(bad, (m) => m.error || m.joined);
  check('wrong room code is refused', r1?.error && /Wrong room code/.test(r1.error), r1?.error);
  bad.kill();

  // a raw TCP client that skips the handshake and sends a forged message
  const raw = await new Promise((res) => {
    const s = net.connect(47180, '127.0.0.1');
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('connect', () => { s.write(JSON.stringify({ t: 'state', paused: true }) + '\n'); });
    s.on('close', () => res(got));
    setTimeout(() => { s.destroy(); res(got + '[still open]'); }, 3000);
  });
  check('a client without the handshake gets nothing and is dropped', /challenge/.test(raw) && !/still open/.test(raw));
  check('the code never travels in the clear', !raw.includes('XM4RT'));

  // right code -> waits for approval
  const a = member('XM4RT', 'Alice');
  const r2 = await until(a, (m) => m.joined || m.error);
  check('right code -> waits for the host to approve', r2?.joined === 'waiting', JSON.stringify(r2));
  const ask = events.find(([c]) => c === 'together-approve');
  check('host is asked to approve', !!ask && ask[1].name === 'Alice');
  T.decide(ask[1].id, true);
  await wait(300);
  check('after Allow the member is in the room', T.status().members.some((m) => m.name === 'Alice'));

  // member sends a normal state + a forged host-only message + a flood
  a.send({ send: { t: 'state', kind: 'play', paused: true, time: 12, rate: 1, file: { name: 'x.mp4', size: 5 } } });
  a.send({ send: { t: 'members', list: [{ name: 'fake' }] } });
  a.send({ send: { t: 'closed' } });
  for (let i = 0; i < 60; i++) a.send({ send: { t: 'chat', text: 'spam ' + i } });
  await wait(800);
  const got = events.filter(([c]) => c === 'together-msg').map(([, d]) => d);
  check('normal playback message arrives (sanitised)', got.some((m) => m.t === 'state' && m.time === 12 && m.fromName === 'Alice'));
  check('host-only messages from a member are dropped', !got.some((m) => m.t === 'members' || m.t === 'closed'));
  const chats = got.filter((m) => m.t === 'chat').length;
  check('message flood is rate-limited', chats > 0 && chats <= 25, `${chats} of 60 chat messages passed`);

  // deny
  const b = member('XM4RT', 'Bob');
  await until(b, (m) => m.joined);
  const askB = events.filter(([c]) => c === 'together-approve').pop();
  T.decide(askB[1].id, false);
  await wait(400);
  check('Deny keeps them out', !T.status().members.some((m) => m.name === 'Bob'));

  // lockout after 5 wrong codes from one address
  for (let i = 0; i < 5; i++) { const x = member('BBBBB', 'Guess' + i); await until(x, (m) => m.error); x.kill(); }
  const y = member('XM4RT', 'AfterGuessing');
  const r3 = await until(y, (m) => m.error || m.joined);
  check('5 wrong codes lock that address out for a minute', r3?.error && /Too many wrong codes/.test(r3.error), r3?.error);
  y.kill();

  a.send({ leave: true }); b.kill();
  T.leave();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
