import process from 'node:process';
import console from 'node:console';
import { stdin, stdout } from 'node:process';
import { emitKeypressEvents, createInterface } from 'node:readline';
import { mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { checksum, siteUrl, nextRecoveryAction, assertReleaseSafe } from './admin-protocol.mjs';
const { fetch } = globalThis;
const RECOVERY_LABELS = {
  new: '尚未开始',
  prepared: '保全材料已生成',
  saved: '材料已保存并校验',
  'launch-unknown': '恢复请求已发送，等待核对',
  launched: '已发出恢复请求',
  restored: '已恢复检查点，等待合并',
  complete: '已完成合并，等待网站核对',
  cancelled: '已取消',
};
const NEXT_LABELS = {
  'save-carry': '保存恢复保全材料并校验',
  launch: '执行已核对的恢复',
  status: '查询原恢复操作的状态',
  complete: '合并保全材料并核对',
  'website-review': '由总裁判在网站核对比赛',
  'select-checkpoint': '选择已保存的检查点',
};
function showRecoveryStatus(result) {
  const state = String(result.state ?? '');
  console.log(
    `恢复状态：${state.startsWith('prepared:') ? '已准备，尚未执行恢复' : state.startsWith('checkpoint:') ? '已到达检查点，等待合并' : state.startsWith('review:') ? '已合并，等待总裁判核对' : state ? '存在恢复操作，请查看详情' : '没有未完成的恢复操作'}\n比赛记录版本：${result.revision ?? '暂未取得'}`,
  );
}

const root = resolve(import.meta.dirname, '..'),
  privateRoot = resolve(root, '.private/platform-admin');
class Back extends Error {}
class Quit extends Back {}
async function privateDirectory() {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32')
    await promisify(execFile)(
      'icacls.exe',
      [privateRoot, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`],
      { windowsHide: true },
    );
}
function select(title, items) {
  console.log(`\n${title}`);
  if (!stdin.isTTY) throw new Error('请在支持方向键输入的终端运行此向导。');
  return new Promise((resolveChoice, reject) => {
    let chosen = 0;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const draw = () => {
      stdout.write(items.map((item, i) => `${i === chosen ? '❯' : ' '} ${item}`).join('\n') + '\n');
    };
    draw();
    const finish = (value, error) => {
      stdin.removeListener('keypress', key);
      stdin.setRawMode(false);
      stdin.pause();
      if (error) reject(error);
      else resolveChoice(value);
    };
    const key = (_str, event) => {
      if (event.ctrl && event.name === 'c') {
        finish(null, new Quit('已安全退出。已提交的步骤和操作编号已保留。'));
        return;
      }
      if (event.name === 'escape') {
        finish(null, new Back('已返回。'));
        return;
      }
      if (event.name === 'return') {
        finish(chosen);
        return;
      }
      if (event.name === 'up' || event.name === 'down') {
        chosen = (chosen + (event.name === 'up' ? -1 : 1) + items.length) % items.length;
        stdout.write(`\x1b[${items.length}A`);
        draw();
      }
    };
    stdin.on('keypress', key);
  });
}
async function prompt(label, { secret = false, defaultValue = '' } = {}) {
  if (secret) {
    stdout.write(`${label}：`);
    return new Promise((resolveValue, reject) => {
      let value = '';
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      const finish = (error) => {
        stdin.removeListener('keypress', key);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        if (error) reject(error);
        else resolveValue(value);
      };
      const key = (str, event) => {
        if (event.ctrl && event.name === 'c') return finish(new Quit('已安全退出。'));
        if (event.name === 'escape') return finish(new Back('已返回。'));
        if (event.name === 'return') return finish();
        if (event.name === 'backspace') {
          value = value.slice(0, -1);
          return;
        }
        if (str && !event.ctrl && !event.meta) value += str;
      };
      stdin.on('keypress', key);
    });
  }
  const recent = (await readdir(privateRoot).catch(() => [])).map((name) =>
    resolve(privateRoot, name),
  );
  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer: (line) => [recent.filter((file) => file.startsWith(line)), line],
  });
  try {
    return await new Promise((resolveValue) =>
      rl.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}：`, (value) =>
        resolveValue(value.trim() || defaultValue),
      ),
    );
  } finally {
    rl.close();
  }
}
async function confirm(text) {
  const answer = await prompt(`请输入“${text}”确认（空白返回）`);
  if (answer !== text) throw new Back('未执行后续步骤。');
}
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  const reread = JSON.parse(await readFile(path, 'utf8'));
  if (checksum(value) !== checksum(reread)) throw new Error('文件回读校验失败，请检查磁盘。');
  return reread;
}
async function loadFile(label) {
  const path = resolve(await prompt(label));
  await access(path);
  return { path, value: JSON.parse(await readFile(path, 'utf8')) };
}
async function runWrangler(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error('基础设施命令未完成，请按显示的错误修正后继续。')),
    );
  });
}
let context;
async function request(operation, extra = {}) {
  const response = await fetch(new URL('/api/maintenance', context.origin), {
    method: 'POST',
    headers: {
      Origin: context.origin,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.maintenanceSecret}`,
    },
    body: JSON.stringify({ operation, ...extra }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '远端操作未完成，请查看原操作状态。');
  return result;
}
async function environment() {
  const files = (await readdir(privateRoot)).filter((name) => name.endsWith('.environment.json'));
  const choice = await select('先选择环境', [...files, '添加环境']);
  if (choice < files.length)
    context = JSON.parse(await readFile(resolve(privateRoot, files[choice]), 'utf8'));
  else {
    const origin = siteUrl(
      await prompt('网站首页地址', { defaultValue: 'http://127.0.0.1:8788' }),
    ).origin;
    const maintenanceSecret = await prompt('独立平台维护凭据（输入不显示）', { secret: true });
    if (!/^[A-Za-z0-9_-]{43}$/.test(maintenanceSecret))
      throw new Error('维护凭据须为正确的随机维护凭据。');
    context = { origin, maintenanceSecret };
  }
  console.log(`\n实际站点：${context.origin}`);
  try {
    const diagnostics = await request('diagnostics');
    console.log(
      `远端环境：${{ local: '本地环境', preview: '预览环境', production: '正式环境' }[diagnostics.environment] ?? '未登记环境'}\n程序版本：${diagnostics.version}\n部署识别摘要：${diagnostics.bindingFingerprint}`,
    );
    if (context.bindingFingerprint && context.bindingFingerprint !== diagnostics.bindingFingerprint)
      throw new Error('绑定指纹已变化，须先核对部署设置。');
    context.bindingFingerprint = diagnostics.bindingFingerprint;
    context.environment = diagnostics.environment;
  } catch (error) {
    console.log(`尚未完成远端核验：${error.message}`);
    await confirm(`首次接入 ${context.origin}`);
  }
  const path = resolve(
    privateRoot,
    `${new URL(context.origin).hostname.replaceAll(/[^a-zA-Z0-9.-]/g, '_')}.environment.json`,
  );
  await save(path, context);
}
async function installation() {
  console.log('请先确认网站和比赛服务已部署，并且网站能连接到比赛服务。');
  const name = await prompt('首次平台所有者显示名称');
  await confirm(`安装网站 ${context.origin}`);
  const response = await fetch(new URL('/api/install', context.origin), {
    method: 'POST',
    headers: {
      Origin: context.origin,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.maintenanceSecret}`,
    },
    body: JSON.stringify({ name }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? '安装未完成。');
  const path = resolve(privateRoot, `owner-delivery-${Date.now()}.json`);
  await save(path, result);
  console.log(
    `所有者邀请已保存到受限目录：${path}\n用浏览器打开 ${context.origin}/claim，将文件中的邀请通过领取页兑换，再设置第二因素。`,
  );
}
async function release() {
  const diagnostics = await request('release-check');
  console.log(`受影响比赛：${diagnostics.matches.length} 场`);
  for (const d of diagnostics.matches) console.log(`${d.name}（${d.id}）`);
  assertReleaseSafe(diagnostics);
  const choice = await select('发布或回滚', [
    '发布已验证程序到预览环境',
    '查看回滚兼容要求',
    '返回',
  ]);
  if (choice === 2) return;
  if (choice === 1) {
    console.log(
      '只在旧程序兼容平台数据版本1与比赛数据版本8时进行纯代码回滚。请先保存检查点并核对目标版本；本向导不会猜测云端版本号。',
    );
    return;
  }
  if (context.environment !== 'preview')
    throw new Error('仓库目前只登记了local与preview运行配置；正式部署须先登记并核对生产绑定。');
  await confirm(`发布程序 ${context.origin}`);
  await runWrangler(['deploy', '--env', 'preview', '--config', 'apps/match-worker/wrangler.jsonc']);
  console.log('后端发布完成。请运行网站构建及Pages部署，再核对版本。');
}
async function rescue() {
  const operationId = randomUUID(),
    name = await prompt('新的所有者显示名称'),
    reason = await prompt('人员核验依据与救援原因');
  await confirm('恢复平台所有者访问');
  const result = await request('rescue-owner', {
    operationId,
    name,
    reason,
    confirm: '恢复平台所有者访问',
  });
  const path = resolve(privateRoot, `rescue-${operationId}.json`);
  await save(path, result);
  console.log(
    `已撤销旧所有者角色及全部旧平台会话。新邀请保存于：${path}\n请在网站领取账号并设置第二因素。`,
  );
}
async function recover(existing) {
  let job = existing;
  if (!job) {
    const diagnostics = await request('diagnostics'),
      matches = diagnostics.matches.filter((m) => m.state !== 'imported_archive');
    if (!matches.length) throw new Error('没有已登记的比赛。');
    const selected = await select(
        '选择比赛（名称相同也按不可变编号区分）',
        matches.map((m) => `${m.name}（${m.id}） ${m.kind === 'trial' ? '试玩' : '正式比赛'}`),
      ),
      match = matches[selected],
      reason = await prompt('恢复依据与原因');
    job = { id: randomUUID(), matchId: match.id, name: match.name, state: 'new', reason };
  }
  const statePath = resolve(privateRoot, `recovery-${job.id}.json`),
    carryPath = resolve(privateRoot, `carry-${job.id}.json`);
  await save(statePath, job);
  console.log(
    `\n比赛：${job.name}（${job.matchId}）\n原操作编号：${job.id}\n当前状态：${RECOVERY_LABELS[job.state] ?? '需要核对'}\n建议下一步：${NEXT_LABELS[nextRecoveryAction(job.state)]}`,
  );
  const status = () =>
    request('recovery', {
      operationId: job.id,
      matchId: job.matchId,
      reason: job.reason,
      payload: { operation: 'status' },
    });
  const action = await select('恢复比赛', [
    '查看当前恢复状态',
    '选择检查点并准备保全材料',
    '保存材料并登记回读收据',
    '执行原生恢复（请求后先查状态）',
    '合并并交还网站核对',
    '取消尚未启动的准备',
    '返回',
  ]);
  const base = { operationId: job.id, matchId: job.matchId, reason: job.reason };
  if (action === 0) {
    showRecoveryStatus(await status());
    return;
  }
  if (action === 1) {
    if (job.state !== 'new') throw new Error('已有操作不能重复生成准备任务，请继续原步骤。');
    const { value: target } = await loadFile('选择检查点文件（Tab补全近期文件）');
    await confirm(`准备恢复 ${job.matchId}`);
    const carry = await request('recovery', {
      ...base,
      payload: { operation: 'prepare', payload: { target, reason: job.reason } },
    });
    await save(carryPath, carry);
    job.state = 'prepared';
    job.carryPath = carryPath;
    await save(statePath, job);
    console.log('比赛已锁定业务写入。恢复保全材料已保存；请登记回读收据。');
  }
  if (action === 2) {
    const carry = JSON.parse(await readFile(job.carryPath ?? carryPath, 'utf8'));
    await request('carry-receipt', { ...base, carry, sha256: checksum(carry) });
    job.state = 'saved';
    await save(statePath, job);
    console.log('材料回读与远端收据均已确认，现在可以执行恢复。');
  }
  if (action === 3) {
    if (job.state !== 'saved')
      throw new Error('先保存材料、登记收据；已启动或结果未知时须先查询状态。');
    await confirm(`恢复比赛 ${job.matchId}`);
    job.state = 'launch-unknown';
    await save(statePath, job);
    const carry = JSON.parse(await readFile(job.carryPath, 'utf8'));
    try {
      await request('recovery', {
        ...base,
        confirm: `恢复比赛 ${job.matchId}`,
        payload: { operation: 'launch', payload: carry },
      });
    } catch {
      console.log('连接在恢复请求后结束，结果待确认。请按原编号查询状态，不能重复启动。');
    }
    console.log('下一步：查询恢复状态，确认目标时间点后完成合并。');
  }
  if (action === 4) {
    const current = await status();
    showRecoveryStatus(current);
    await confirm(`核对并合并比赛 ${job.matchId}`);
    const carry = JSON.parse(await readFile(job.carryPath, 'utf8'));
    await request('recovery', { ...base, payload: { operation: 'complete', payload: carry } });
    job.state = 'complete';
    await save(statePath, job);
    console.log(
      `恢复已合并；比赛仍须保持暂停。请重新登录 ${context.origin}/m/${job.matchId}/judge/recovery，由总裁判完成网站核对后另行恢复比赛。`,
    );
  }
  if (action === 5) {
    if (['launch-unknown', 'complete'].includes(job.state))
      throw new Error('恢复已启动或结果未知，不能取消；请继续核对。');
    await request('recovery', {
      ...base,
      payload: {
        operation: 'cancel',
        payload: job.carryPath ? JSON.parse(await readFile(job.carryPath, 'utf8')) : undefined,
      },
    });
    job.state = 'cancelled';
    await save(statePath, job);
    console.log('已取消尚未启动的恢复准备。');
  }
}
async function resume() {
  const files = (await readdir(privateRoot)).filter((name) =>
    /^(recovery|migration)-.*\.json$/.test(name),
  );
  const jobs = (
    await Promise.all(
      files.map(async (file) => ({
        file,
        job: JSON.parse(await readFile(resolve(privateRoot, file), 'utf8')),
      })),
    )
  ).filter(({ job }) => !['complete', 'cancelled'].includes(job.state));
  if (!jobs.length) {
    console.log('没有可以继续的本地操作。');
    return;
  }
  const selected =
    jobs[
      await select(
        '继续原操作',
        jobs.map(
          ({ file, job }) =>
            `${file.startsWith('migration-') ? '接入旧比赛' : '恢复比赛'}：${job.name}（${job.id}）`,
        ),
      )
    ];
  if (selected.file.startsWith('migration-')) await adoptLegacy(selected.job);
  else await recover(selected.job);
}
async function adoptLegacy(existing) {
  const matchId = existing?.matchId ?? (await prompt('旧比赛编号')),
    name = existing?.name ?? (await prompt('比赛显示名称')),
    reason = existing?.reason ?? (await prompt('人员核对、维护窗口与迁移原因')),
    id = existing?.id ?? randomUUID();
  const statePath = resolve(privateRoot, `migration-${id}.json`),
    job = {
      id,
      matchId,
      name,
      reason,
      state: existing?.state ?? 'inspecting',
      checkpointDigest: existing?.checkpointDigest,
    };
  await save(statePath, job);
  if (!job.checkpointDigest) {
    const inventory = await request('inspect-legacy', { operationId: id, matchId, reason });
    const backupPath = resolve(privateRoot, `legacy-checkpoint-${id}.json`);
    const checkpoint = await save(backupPath, inventory.checkpoint);
    job.checkpointDigest = checksum(checkpoint);
    console.log(
      `比赛：${name}（${matchId}）\n原比赛记录版本：${inventory.revision}\n旧账号：${inventory.accounts.length}个\n已发行手环配置：${inventory.issued.count}枚\n加密检查点已保存并回读：${backupPath}\n每个旧账号将单独建立长期账号；同名和相同文明编号不会自动合并。`,
    );
  } else console.log(`继续接入 ${name}（${matchId}）。保留原操作编号与已校验的检查点。`);
  await confirm(`接入旧比赛 ${matchId}`);
  job.state = 'adopting';
  await save(statePath, job);
  const result = await request('adopt-legacy', {
    operationId: id,
    matchId,
    name,
    reason,
    checkpointDigest: job.checkpointDigest,
    confirm: `接入旧比赛 ${matchId}`,
  });
  job.state = 'complete';
  await save(statePath, job);
  console.log(
    `${result.message ?? '旧比赛已登记。'}\n比赛入口：${context.origin}/m/${matchId}/player\n原参赛者请在领取页面输入各自旧口令，生成长期口令。`,
  );
}
async function main() {
  await privateDirectory();
  console.log('黑暗森林：部署与救援向导\n方向键选择，Enter继续，Esc返回，Ctrl+C安全退出。');
  await environment();
  for (;;) {
    try {
      const choice = await select(
        `当前网站：${context.origin}${context.environment === 'production' ? '【正式环境】' : ''}`,
        [
          '首次建立网站所有者',
          '发布或检查回滚条件',
          '接入已暂停的旧比赛',
          '从检查点恢复比赛',
          '恢复平台所有者访问',
          '继续未完成的恢复或接入操作',
          '查看脱敏诊断',
          '退出',
        ],
      );
      if (choice === 7) return;
      if (choice === 0) await installation();
      if (choice === 1) await release();
      if (choice === 2) await adoptLegacy();
      if (choice === 3) await recover();
      if (choice === 4) await rescue();
      if (choice === 5) await resume();
      if (choice === 6) {
        const result = await request('diagnostics');
        const path = resolve(privateRoot, `diagnostics-${Date.now()}.json`);
        await save(path, result);
        console.log(`脱敏诊断已保存：${path}`);
      }
    } catch (error) {
      console.log(`\n${error.message}`);
      if (error instanceof Quit) return;
    }
  }
}
if (process.argv.includes('--help'))
  console.log(
    '运行 npm run admin:wizard。使用交互式中文菜单；凭据与恢复保全材料保存在 .private/platform-admin，文件不会进入Git。',
  );
else
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error instanceof Back ? 0 : 1;
  });
