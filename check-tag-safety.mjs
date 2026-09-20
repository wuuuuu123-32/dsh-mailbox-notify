// 决定性验证：用插件 cleanupOld 的同一条搜索条件 SEARCH SUBJECT "dsh"，
// 看它会不会命中 [票务监控] 邮件。命中的邮件就是会被删的邮件。
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
    if (line.startsWith(`${waiter.tag} `)) { const d = waiter; waiter = null; const b = lines; lines = []; d.resolve(b); }
  }
};
socket.on('data', (c) => { pending += c.toString('utf8'); pump(); });
const wait = (tag) => new Promise((resolve) => { waiter = { tag, resolve }; pump(); });
const say = (l) => socket.write(`${l}\r\n`);

await wait('*');
say(`f1 LOGIN ${quote(file.mail.user)} ${quote(file.mail.pass)}`);
await wait('f1');
say('f2 SELECT "INBOX"');
await wait('f2');

async function run(tag, cmd, label) {
  say(`${tag} ${cmd}`);
  const res = await wait(tag);
  const hit = res.find((l) => l.startsWith('* SEARCH'));
  const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : [];
  console.log(`\n${label}\n  条件: ${cmd}\n  命中 ${ids.length} 封: ${ids.join(',') || '(无)'}`);
  if (ids.length > 0) {
    say(`${tag}b FETCH ${ids.join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
    const fetched = await wait(`${tag}b`);
    for (const line of fetched) {
      if (/^Subject:/i.test(line)) {
        let raw = line.replace(/^Subject:\s*/i, '').trim();
        const m = /=\?utf-8\?B\?([^?]+)\?=/i.exec(raw);
        if (m) { try { raw = raw.replace(m[0], Buffer.from(m[1], 'base64').toString('utf8')); } catch { /* keep */ } }
        console.log(`     · ${raw.slice(0, 80)}`);
      }
    }
  }
  return ids;
}

// 1) 插件的删除条件
const dsh = await run('g1', 'SEARCH SUBJECT "dsh"', '【插件清理条件】SEARCH SUBJECT "dsh"');
// 2) 我们的前缀（中文需 CHARSET）
const tag = await run('g2', 'SEARCH CHARSET UTF-8 SUBJECT "票务监控"', '【我们的前缀】SEARCH SUBJECT "票务监控"');

console.log('\n================ 结论 ================');
const overlap = tag.filter((id) => dsh.includes(id));
if (tag.length === 0) {
  console.log('⚠️ 搜不到 [票务监控] 邮件（可能中文 CHARSET 不被支持），改用上面的命中列表人工判断。');
} else if (overlap.length === 0) {
  console.log(`✅ 避让有效：${tag.length} 封 [票务监控] 邮件没有一封落在插件删除条件里，不会被误删。`);
} else {
  console.log(`❌ 危险：${overlap.length} 封会被插件的清理误删！`);
}
if (dsh.length > 0) console.log(`   （插件条件命中的 ${dsh.length} 封是它自己的通知，属正常清理对象）`);

say('z9 LOGOUT');
socket.end();
