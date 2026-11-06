import {useState} from 'react';
import {useApp} from '../../state';
import {Disclosure, Field, Icon, formatTime} from '../../ui';
import {RecordPagination} from '../record_pagination';

/** 按服务端分页游标展示真实操作审计，不从本地操作推测成功记录。 */
export function AuditEntries() {
  const {data} = useApp();
  const [search, setSearch] = useState('');
  return (
    <div className="audit-list">
      <Field label="检索操作记录">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="操作者、文明、动作或原因"
        />
      </Field>
      <RecordPagination kind="audits" />
      {data
        .judge!.audits.filter(a =>
          `${a.title} ${a.operator} ${a.target ?? ''} ${a.reason}`.includes(
            search,
          ),
        )
        .map(a => (
          <Disclosure key={a.id} title={`${a.title}，${formatTime(a.gameMs)}`}>
            <p>操作者：{a.operator}</p>
            <p>原因：{a.reason}</p>
            {a.target && (
              <p>
                对象：{a.target}；
                {a.status === 'previewed'
                  ? '操作预览'
                  : a.status === 'failed'
                    ? '执行失败'
                    : '执行记录'}
              </p>
            )}
            {a.utcMs && (
              <p className="secondary">
                记录时间：{new Date(a.utcMs).toLocaleString('zh-CN')}
              </p>
            )}
            <div className="change-row">
              <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>
                {a.before}
              </pre>
              <Icon name="arrow" size={18} />
              <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>
                {a.after}
              </pre>
            </div>
            <p className="muted">记录编号：{a.id}</p>
          </Disclosure>
        ))}
    </div>
  );
}
