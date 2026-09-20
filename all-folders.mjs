// 遍历所有 IMAP 文件夹，列出最近邮件主题，定位 [票务监控] 邮件到底落在哪里
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

const file = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const quote = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;

const socket = tls.connect({ host: 'imap.qq.com', port: 993, servername: 'imap.qq.com' });
await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });

let pending = '';
let lines = [];
let waiter = null;
const pump = () => {
  while (waiter) {
    const idx = pending.indexOf('\r\n');
    if (idx < 0) return;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 2);
    lines.push(line);
    if (line.startsWith(`${waiter.tag} `)) {
      const done = waiter; waiter = null; const batch = lines; lines = []; done.resolve(batch);
    }
  }
};
socket.on('data', (c) => { pending += c.toString('utf8'); pump(); });
const wait = (tag) => new Promise((resolve) => { waiter = { tag, resolve }; pump(); });
const say = (l) => socket.write(`${l}\r\n`);

await wait('*');
say(`b1 LOGIN ${quote(file.mail.user)} ${quote(file.mail.pass)}`);
const login = await wait('b1');
if (!/\bb1 OK/i.test(login.join('\n'))) { console.log('登录失败'); process.exit(1); }

say('b2 LIST "" "*"');
const listed = await wait('b2');
const folders = listed
  .filter((l) => l.startsWith('* LIST'))
  .map((l) => { const m = /(?:"([^"]*)"|(\S+))\s*$/.exec(l); return m ? (m[1] ?? m[2]) : null; })
  .filter(Boolean);

console.log('共发现文件夹:', folders.length, '\n');

let n = 0;
for (const folder of folders) {
  const tag = `c${n++}`;
  say(`${tag} SELECT ${quote(folder)}`);
  const sel = await wait(tag);
  if (!/\bOK/i.test(sel.join('\n'))) continue;
  const existsLine = sel.find((l) => /^\* \d+ EXISTS/.test(l));
  const total = existsLine ? existsLine.match(/^\* (\d+) EXISTS/)[1] : '0';

  const t2 = `d${n++}`;
  say(`${t2} SEARCH ALL`);
  const res = await wait(t2);
  const hit = res.find((l) => l.startsWith('* SEARCH'));
  const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : [];
  const recent = ids.slice(-3);

  console.log(`── ${folder}  (共 ${total} 封${recent.length ? '，看最近 ' + recent.length + ' 封' : ''})`);
  if (recent.length > 0) {
    const t3 = `e${n++}`;
    say(`${t3} FETCH ${recent.join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
    const fetched = await wait(t3);
    for (const line of fetched) {
      if (/^Subject:/i.test(line)) {
        let raw = line.replace(/^Subject:\s*/i, '').trim();
        const m = /=\?utf-8\?B\?([^?]+)\?=/i.exec(raw);
        if (m) { try { raw = Buffer.from(m[1], 'base64').toString('utf8'); } catch { /* keep */ } }
        const isOurs = /票务监控|dsh/i.test(raw);
        console.log(`     ${isOurs ? '★' : ' '} ${raw.slice(0, 70)}`);
      }
    }
  }
}

say('z9 LOGOUT');
socket.end();
