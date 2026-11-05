import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const { fetch } = globalThis;
const args = process.argv.slice(2),
  operation = args[0];
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const origin = option('--origin'),
  secretFile = option('--secret-file'),
  input = option('--input'),
  output = option('--output');
if (
  !origin ||
  !secretFile ||
  !['prepare', 'launch', 'complete', 'cancel', 'status'].includes(operation)
)
  throw new Error(
    '用法：node scripts/recovery.mjs prepare|launch|complete|cancel|status --origin <站点> --secret-file <私有密钥文件> --input <恢复文件> --output <输出文件>',
  );
const url = new URL(origin);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('恢复入口须使用HTTPS。');
const secrets = JSON.parse(await readFile(resolve(secretFile), 'utf8'));
if (!secrets.BOOTSTRAP_SECRET) throw new Error('缺少恢复授权。');
let payload;
if (operation !== 'status' && (operation !== 'cancel' || input)) {
  if (!input) throw new Error('请指定--input。');
  payload = JSON.parse(await readFile(resolve(input), 'utf8'));
  if (operation === 'prepare')
    payload = { target: payload, reason: option('--reason') ?? '经总裁判确认的比赛恢复' };
}
if (operation === 'prepare' && !output)
  throw new Error('prepare须指定--output，保存材料后再执行launch。');
let response;
try {
  response = await fetch(new URL('/api/recovery', url), {
    method: 'POST',
    headers: {
      Origin: url.origin,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secrets.BOOTSTRAP_SECRET}`,
    },
    body: JSON.stringify({ operation, payload }),
  });
} catch (error) {
  if (operation === 'launch') {
    console.log('恢复启动请求已结束。请运行status核对目标时间点，再运行complete。');
    process.exit(0);
  }
  throw error;
}
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.message ?? result.code}`);
if (output) {
  await writeFile(resolve(output), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`恢复材料已保存：${resolve(output)}`);
} else console.log(JSON.stringify(result));
