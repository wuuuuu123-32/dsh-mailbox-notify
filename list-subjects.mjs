// 列出收件箱最近 N 封邮件的主题，确认 [票务监控] 邮件是否到达、主题原文是什么
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

const file = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const USER = file.mail.user;
const PASS = file.mail.pass;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const quote = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
const N = Number(process.argv[2] ?? 6);

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
say(`a1 LOGIN ${quote(USER)} ${quote(PASS)}`);
const login = await wait('a1');
if (!/\ba1 OK/i.test(login.join('\n'))) { console.log('登录失败'); process.exit(1); }

say('a2 SELECT "INBOX"');
const sel = await wait('a2');
const existsLine = sel.find((l) => /^\* \d+ EXISTS/.test(l));
console.log('收件箱邮件总数:', existsLine ? existsLine.match(/^\* (\d+) EXISTS/)[1] : '(未知)');

say('a3 SEARCH ALL');
const all = await wait('a3');
const hit = all.find((l) => l.startsWith('* SEARCH'));
const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : [];
const recent = ids.slice(-N);
console.log(`最近 ${recent.length} 封（序号 ${recent.join(',')}）:\n`);

if (recent.length > 0) {
  say(`a4 FETCH ${recent.join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT DATE)])`);
  const fetched = await wait('a4');
  for (const line of fetched) {
    if (/^Subject:/i.test(line)) {
      let raw = line.replace(/^Subject:\s*/i, '').trim();
      // 解码 MIME 编码主题
      const m = /=\?UTF-8\?B\?([^?]+)\?=/i.exec(raw);
      if (m) {
        try { raw = Buffer.from(m[1], 'base64').toString('utf8') + '   [原文 MIME-B]'; } catch { /* keep */ }
      }
      const hasDsh = /dsh/i.test(raw);
      console.log(`  ${hasDsh ? '⚠️含dsh' : '✅不含dsh'}  ${raw}`);
    }
  }
}

say('a9 LOGOUT');
socket.end();
