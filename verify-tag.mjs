// 验证「邮件标签避让」是否真的有效：
// 1) 发一封带 [票务监控] 前缀的测试信
// 2) 用 IMAP 分别按 "dsh" 和 "票务监控" 搜索
// 3) 若前者搜不到、后者搜得到 → 插件的 cleanupOld（SEARCH SUBJECT "dsh"）不会误删监控邮件
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { sendMail } from './index.js';

const file = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const USER = file.mail.user;
const PASS = file.mail.pass;
const IMAP_HOST = file.imap?.host ?? 'imap.qq.com';
const IMAP_PORT = file.imap?.port ?? 993;

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const quote = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;

function makeReader(socket) {
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
        const done = waiter;
        waiter = null;
        const batch = lines;
        lines = [];
        done.resolve(batch);
      }
    }
  };
  socket.on('data', (chunk) => { pending += chunk.toString('utf8'); pump(); });
  return (tag) => new Promise((resolve) => { waiter = { tag, resolve }; pump(); });
}

const TAG = '[票务监控]';
const SUBJECT = `${TAG} 标签避让验证`;

console.log('① 发送一封带新前缀的测试邮件…');
await sendMail(
  { ...file.mail, timeoutMs: 25000 },
  `=?UTF-8?B?${b64(SUBJECT)}?=`,
  [
    '这是一封用于验证「邮件标签避让」的测试信。',
    '',
    `主题前缀：${TAG}`,
    '目的：确认 dsh-mailbox-notify 的 cleanupOld（IMAP SEARCH SUBJECT "dsh"）不会把这封邮件删掉。',
    '',
    `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n'),
);
console.log('   已发送 ✓\n');

console.log('② 连 IMAP 检查搜索行为…');
const socket = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST });
await new Promise((resolve, reject) => {
  socket.once('secureConnect', resolve);
  socket.once('error', reject);
});
const wait = makeReader(socket);
const say = (line) => socket.write(`${line}\r\n`);

await wait('*');
say(`t1 LOGIN ${quote(USER)} ${quote(PASS)}`);
const login = await wait('t1');
if (!/\bt1 OK/i.test(login.join('\n'))) {
  console.log('   IMAP 登录失败：' + login[login.length - 1]);
  process.exit(1);
}
say('t2 SELECT "INBOX"');
await wait('t2');

async function search(tag, cmd, label) {
  say(`${tag} ${cmd}`);
  const res = await wait(tag);
  const hit = res.find((l) => l.startsWith('* SEARCH'));
  const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : [];
  console.log(`   ${label} → 命中 ${ids.length} 封${ids.length ? '（序号 ' + ids.join(',') + '）' : ''}`);
  return ids;
}

const byDsh = await search('t3', 'SEARCH SUBJECT "dsh"', 'SEARCH SUBJECT "dsh"  （插件清理用的条件）');
const byTag = await search('t4', 'SEARCH CHARSET UTF-8 SUBJECT "票务监控"', 'SEARCH SUBJECT "票务监控"（我们的新前缀）');

console.log('');
console.log('=== 结论 ===');
console.log(`"dsh" 命中 ${byDsh.length} 封；"票务监控" 命中 ${byTag.length} 封。`);
if (byTag.length > 0 && byDsh.length === 0) {
  console.log('✅ 避让有效：新前缀邮件不会被插件的清理规则匹配到。');
} else if (byTag.length > 0) {
  const overlap = byTag.filter((id) => byDsh.includes(id));
  console.log(overlap.length === 0
    ? `✅ 避让有效：两组结果无交集（dsh 那 ${byDsh.length} 封是插件自己的旧通知）。`
    : `❌ 危险：有 ${overlap.length} 封同时被两条规则命中，会被误删！`);
} else {
  console.log('⚠️ 未搜到新前缀邮件（可能 IMAP 搜索不支持中文 CHARSET，或邮件尚未入库）——请稍后手动确认。');
}

say('t9 LOGOUT');
socket.end();
