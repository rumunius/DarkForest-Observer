import {COLORS, type SiteConfig} from '@darkforest/contracts';
import {useState} from 'react';
import {MatchLinks} from '../../components/match_context';
import {DEFAULT_SITE} from '../../config';
import {handleAsync} from '../../data/async_event';
import {judgeCan} from '../../permissions';
import {useApp} from '../../state';
import {Button, Field, Frame, Icon, PageTitle} from '../../ui';
import {AccountsManagement} from '../accounts';
import {JUDGE_NAV} from './navigation';
import {ParametersSettings, RosterSettings} from '../parameters';

/** 编辑获准的公共站点配置并预览影响，密钥不属于此表单。 */
export function Settings() {
  const {reportError, data, operate, busy} = useApp();
  const [site, setSite] = useState<SiteConfig>(structuredClone(data.site));
  const [preview, setPreview] = useState(false);
  const [reason, setReason] = useState('');
  const change = (
    key: 'title' | 'description' | 'qqGroup' | 'judgeContact' | 'endgameFile',
    value: string,
  ) => {
    setSite({...site, [key]: value});
    setPreview(false);
  };
  const colorsValid = COLORS.every(c =>
    /^#[0-9a-f]{6}$/i.test(site.colors[c.id]),
  );
  return (
    <>
      <PageTitle title="活动设置" />
      <RosterSettings />
      <ParametersSettings />
      <div className="settings-grid">
        <section>
          {(
            [
              ['title', '活动名称'],
              ['description', '参与说明'],
              ['qqGroup', 'QQ群名称与号码'],
              ['judgeContact', '裁判联系方式'],
              ['endgameFile', 'QQ群终局图片文件名称'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                value={site[key]}
                onChange={e => change(key, e.target.value)}
              />
            </Field>
          ))}
        </section>
        <section>
          <h2>手环颜色</h2>
          <p className="secondary">
            七个颜色身份及顺序固定，只调整全站显示色值。
          </p>
          <div className="color-settings">
            {COLORS.map(color => (
              <div className="color-setting" key={color.id}>
                <label>
                  <input
                    type="color"
                    aria-label={`${color.name}取色`}
                    value={
                      /^#[0-9a-f]{6}$/i.test(site.colors[color.id])
                        ? site.colors[color.id]
                        : '#000000'
                    }
                    onChange={e => {
                      setSite({
                        ...site,
                        colors: {...site.colors, [color.id]: e.target.value},
                      });
                      setPreview(false);
                    }}
                  />
                  <span>{color.name}</span>
                </label>
                <input
                  aria-label={`${color.name}十六进制色值`}
                  value={site.colors[color.id]}
                  maxLength={7}
                  onChange={e => {
                    setSite({
                      ...site,
                      colors: {...site.colors, [color.id]: e.target.value},
                    });
                    setPreview(false);
                  }}
                />
              </div>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() => {
              setSite({...site, colors: {...DEFAULT_SITE.colors}});
              setPreview(false);
            }}
          >
            重置为初始色值
          </button>
        </section>
      </div>
      <Field label="变更原因">
        <textarea
          value={reason}
          onChange={e => {
            setReason(e.target.value);
            setPreview(false);
          }}
        />
      </Field>
      <Button
        disabled={!colorsValid || !reason.trim() || !site.title.trim() || busy}
        onClick={() => setPreview(true)}
      >
        预览并核对设置
      </Button>
      {preview && (
        <Frame>
          <h2>设置变更预览</h2>
          <p>{site.title}</p>
          <div className="material-colors">
            {COLORS.map(c => (
              <span key={c.id}>
                <span
                  className="mini-band"
                  style={{backgroundColor: site.colors[c.id]}}
                />
                {c.name}
              </span>
            ))}
          </div>
          <p>
            保存后，颜色配置版本将从第{data.site.version}
            版更新，覆盖首航、目击、本人手环、观战、历史与大屏展示。比赛中变更会记录操作者及原因。
          </p>
          <Button
            className="primary full"
            disabled={busy}
            onClick={handleAsync(async () => {
              const r = await operate('/judge/site-config', {
                site,
                expected_version: data.site.version,
                reason,
              });
              if (r?.status === 'complete') {
                setPreview(false);
              }
            }, reportError)}
          >
            确认保存活动设置
          </Button>
        </Frame>
      )}
    </>
  );
}

/** 展示本场裁判账号与退出入口，账号安全由平台专用页面处理。 */
export function JudgeAccount() {
  const {data, logout} = useApp();
  return (
    <>
      <PageTitle title="裁判账号" />
      <MatchLinks />
      <AccountsManagement />
      <h2>{data.session!.name}</h2>
      <p className="secondary">当前账号可以使用以下功能。</p>
      <div className="permission-list">
        {JUDGE_NAV.flatMap(g => g.items)
          .filter(([area]) => judgeCan(data, area!))
          .map(([area, label]) => (
            <span key={area}>
              <Icon name="check" size={16} />
              {label}
            </span>
          ))}
      </div>
      <Button onClick={() => void logout()}>
        <Icon name="logout" size={18} />
        退出登录
      </Button>
    </>
  );
}
