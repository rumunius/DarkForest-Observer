import type {
  MatchDownload,
  MatchEntry,
  MatchHistory,
  PlatformOperation,
} from '@darkforest/contracts';
import {useEffect, useState} from 'react';
import type {PlatformClient} from '../data/platform';
import {saveDownload} from '../data/platform';
import {HumanData, OPERATION_NAMES} from '../platform_copy';
import {Button, Field} from '../ui';
import {Matches} from './matches';
import type {Run} from './shared';
import {Header, Label, states, useRows} from './shared';

/** 展示持久平台操作及收据，未知结果要求查询原操作而不重复提交。 */
export function Operations({
  client,
  tick,
  run,
}: {
  client: PlatformClient;
  tick: number;
  run: Run;
}) {
  const {data, error} = useRows<PlatformOperation[]>(
    client,
    '/platform/operations',
    tick,
  );
  return (
    <>
      <Header title="管理待办" />
      <Button onClick={() => void run(async () => {})}>刷新任务</Button>
      {error && <p role="alert">{error}</p>}
      {data?.map(op => (
        <article key={op.id} className="platform-match-row">
          <div>
            <Label>{states[op.status]}</Label>
            <h2>{OPERATION_NAMES[op.action] ?? '平台管理操作'}</h2>
            <small>{op.id}</small>
            <p>{op.error}</p>
            <details>
              <summary>各项处理结果与下一步</summary>
              <HumanData value={op} />
            </details>
          </div>
          {['failed', 'partial'].includes(op.status) && (
            <Button
              onClick={() =>
                void run(() =>
                  client.mutate(
                    '/platform/operations/retry',
                    {
                      operationId: op.id,
                      reason: '已核对失败步骤，按原编号继续',
                    },
                    true,
                  ),
                )
              }
            >
              重试未完成步骤
            </Button>
          )}
        </article>
      ))}
      <Matches client={client} tick={tick} run={run} manage />
    </>
  );
}

/** 在获授权场次范围内管理保留、清理和资料下载。 */
export function DataCenter({
  client,
  tick,
  run,
}: {
  client: PlatformClient;
  tick: number;
  run: Run;
}) {
  const {data: matches} = useRows<MatchEntry[]>(
    client,
    '/platform/matches',
    tick,
  );
  const {data} = useRows<{holds: Array<{match_id: string}>; ledger: unknown[]}>(
    client,
    '/platform/data',
    tick,
  );
  const [selected, setSelected] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{
    path: string;
    body: Record<string, unknown>;
    token: string;
    details: unknown;
  } | null>(null);
  const d = matches?.find(m => m.id === selected);
  const held = data?.holds.some(hold => hold.match_id === selected);
  const planCleanup = async () => {
    const body = {matchId: selected, expected_version: d?.version, reason};
    const path = '/platform/data/purge';
    const result = await client.request<{previewToken: string}>(
      '/platform/preview',
      {
        path,
        payload: body,
      },
    );
    setPreview({path, body, token: result.previewToken, details: result});
  };
  return (
    <>
      <Header title="历史与数据" />
      <p>
        比赛结束后可下载赛后资料。请将需要留存的文件保存到主办方自己的设备或文件夹。
      </p>
      <Field label="选择比赛">
        <select
          value={selected}
          onChange={e => {
            setSelected(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">请选择</option>
          {matches?.map(d => (
            <option key={d.id} value={d.id}>
              {d.name}，{d.kind === 'trial' ? '试玩' : '正式比赛'}，
              {states[d.state]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="操作原因与核验依据">
        <textarea
          value={reason}
          onChange={e => {
            setReason(e.target.value);
            setPreview(null);
          }}
        />
      </Field>
      <div className="platform-row-actions">
        {d && (
          <a href={`/m/${d.id}/history?audience=staff`}>查看与下载赛后资料</a>
        )}
        <Button
          disabled={
            !d ||
            !reason ||
            !!held ||
            d.state === 'purge_pending' ||
            d.state === 'purged'
          }
          onClick={() => void run(planCleanup)}
        >
          预览到期清理
        </Button>
        <Button
          disabled={!d || !reason}
          onClick={() =>
            void run(() =>
              client.mutate(
                '/platform/data/hold',
                {
                  matchId: selected,
                  expected_version: d?.version,
                  reason,
                  ...(held
                    ? {release: true}
                    : {reviewUtc: Date.now() + 30 * 86400000}),
                },
                true,
              ),
            )
          }
        >
          {held ? '解除申诉保留' : '因申诉暂缓清理'}
        </Button>
      </div>
      {preview && (
        <section className="platform-detail">
          <HumanData value={preview.details} />
          <Button
            onClick={() =>
              void run(() =>
                client.request<unknown>(preview.path, {
                  ...preview.body,
                  request_id: crypto.randomUUID(),
                  preview_token: preview.token,
                }),
              )
            }
          >
            确认安排清理
          </Button>
        </section>
      )}
      <details>
        <summary>查看申诉保留和清理记录</summary>
        <HumanData value={data} />
      </details>
      <Operations client={client} tick={tick} run={run} />
    </>
  );
}

const downloadLabels: Record<MatchDownload, string> = {
  report: '下载战报',
  replay: '下载完整复盘',
  audit: '下载裁判操作记录',
  backup: '下载加密备份',
};

/** 按主办方身份和保留范围展示战报版本及可用资料下载。 */
export function History({client, id}: {client: PlatformClient; id: string}) {
  const [history, setHistory] = useState<MatchHistory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<{label: string; data: unknown} | null>(
    null,
  );
  const path = `/matches/${id}/history`;
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then(() => client.request<MatchHistory>(path))
      .then(value => {
        if (active) {
          setHistory(value);
        }
      })
      .catch(e => {
        if (active) {
          setError(
            e instanceof Error
              ? e.message
              : '暂时无法读取赛后资料，请刷新重试。',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [client, path]);
  async function run(work: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error && e.name !== 'AbortError'
          ? e.message
          : '操作未完成，请稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }
  function view(label: string, subpath: string) {
    setRecord(null);
    return run(async () =>
      setRecord({
        label,
        data: await client.request<unknown>(`${path}/${subpath}`),
      }),
    );
  }
  function download(kind: MatchDownload, version?: number) {
    return run(async () => {
      const file = await client.request<{fileName: string; text: string}>(
        `${path}/download/${kind}${version === undefined ? '' : `?version=${version}`}`,
      );
      saveDownload(file.fileName, file.text);
    });
  }
  return (
    <main className="platform-history">
      <Header title="赛后资料" />
      {error && (
        <p className="danger" role="alert">
          {error}
        </p>
      )}
      {!history && !error && <p role="status">正在读取赛后资料。</p>}
      {history && history.phase !== 'ended' && (
        <section className="platform-detail">
          比赛结束后可以在这里查看战报。
        </section>
      )}
      {history?.phase === 'ended' && history.versions.length === 0 && (
        <section className="platform-detail">目前没有可查看的战报。</section>
      )}
      {history?.versions.map(row => (
        <article key={row.version} className="platform-match-row">
          <div>
            <h2>第{row.version}版战报</h2>
            <p>发布于 {new Date(row.created_utc).toLocaleString('zh-CN')}</p>
            {row.correction_reason && <p>更正原因：{row.correction_reason}</p>}
          </div>
          <div className="platform-row-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void view(
                  `第${row.version}版战报`,
                  `report?version=${row.version}`,
                )
              }
            >
              查看战报
            </Button>
            {history.downloads.includes('report') && (
              <Button
                disabled={busy}
                onClick={() => void download('report', row.version)}
              >
                下载战报
              </Button>
            )}
          </div>
        </article>
      ))}
      {history?.replayAvailable && (
        <Button disabled={busy} onClick={() => void view('完整复盘', 'replay')}>
          查看完整复盘
        </Button>
      )}
      {history?.phase === 'ended' &&
        history.versions.length > 0 &&
        !history.replayAvailable && (
          <p>本场目前只提供战报，不再提供完整复盘。</p>
        )}
      {!!history?.downloads.length && (
        <section className="platform-detail">
          <h2>主办方留存资料</h2>
          <p>
            文件下载后由主办方自行保管。请把包含比赛秘密的资料放在仅授权人员可访问的位置。
          </p>
          <div className="platform-row-actions">
            {history.downloads
              .filter(kind => kind !== 'report')
              .map(kind => (
                <Button
                  key={kind}
                  disabled={busy}
                  onClick={() => void download(kind)}
                >
                  {downloadLabels[kind]}
                </Button>
              ))}
          </div>
        </section>
      )}
      {record && (
        <section className="platform-detail">
          <h2>{record.label}</h2>
          <HumanData value={record.data} />
        </section>
      )}
    </main>
  );
}
