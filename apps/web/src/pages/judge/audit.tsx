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
        .map(auditEntry => (
          <Disclosure
            key={auditEntry.id}
            title={`${auditEntry.title}，${formatTime(auditEntry.gameMs)}`}
          >
            <p>操作者：{auditEntry.operator}</p>
            <p>原因：{auditEntry.reason}</p>
            {auditEntry.target && (
              <p>
                对象：{auditEntry.target}；
                {auditEntry.status === 'previewed'
                  ? '操作预览'
                  : auditEntry.status === 'failed'
                    ? '执行失败'
                    : '执行记录'}
              </p>
            )}
            {auditEntry.utcMs && (
              <p className="secondary">
                记录时间：{new Date(auditEntry.utcMs).toLocaleString('zh-CN')}
              </p>
            )}
            <div className="change-row">
              <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>
                {auditEntry.before}
              </pre>
              <Icon name="arrow" size={18} />
              <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>
                {auditEntry.after}
              </pre>
            </div>
            <p className="muted">记录编号：{auditEntry.id}</p>
          </Disclosure>
        ))}
    </div>
  );
}
