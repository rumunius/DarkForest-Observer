import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountCsv, readAccountCsv } from '../../apps/web/src/data/csv';
import { saveDownload } from '../../apps/web/src/data/platform';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function captureDownload(fileName: string, text: string) {
  vi.useFakeTimers();
  let file!: Blob;
  const link = { href: '', download: '', click: vi.fn() };
  vi.stubGlobal('document', { createElement: () => link });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    file = blob as Blob;
    return 'blob:csv-test';
  });
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  saveDownload(fileName, text);
  expect(link.download).toBe(fileName);
  expect(link.click).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith('blob:csv-test');
  return file;
}

describe('Windows Excel账号CSV编码兼容', () => {
  it('下载CSV包含UTF-8 BOM和正确类型，重新上传后中文及编号保持原样', async () => {
    const csv = 'name,kind,accountId\r\n示例玩家,player,\r\n中文工作人员,staff,account-1\r\n';
    const file = captureDownload('账号导入模板.csv', csv);
    expect(file.type).toBe('text/csv;charset=utf-8');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()).slice(0, 3))).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    expect(accountCsv(await readAccountCsv(file))).toEqual([
      { name: '示例玩家', kind: 'player' },
      { name: '中文工作人员', kind: 'staff', accountId: 'account-1' },
    ]);
  });

  it('兼容无BOM的UTF-8以及Excel保存的GBK中文CSV', async () => {
    const csv = 'name,kind,accountId\r\n中文,player,\r\n';
    const gbk = new Blob([
      new TextEncoder().encode('name,kind,accountId\r\n'),
      new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), // 中文 in GBK
      new TextEncoder().encode(',player,\r\n'),
    ]);
    for (const file of [new Blob([csv]), gbk]) {
      expect(accountCsv(await readAccountCsv(file))).toEqual([{ name: '中文', kind: 'player' }]);
    }
  });

  it('无法解码时给出错误，不静默导入替代字符', async () => {
    await expect(readAccountCsv(new Blob([new Uint8Array([0xff])]))).rejects.toThrow(
      '无法识别CSV文件编码',
    );
  });

  it('CSV不重复添加BOM，JSON下载保持原字节', async () => {
    const csv = captureDownload('accounts.CSV', '\uFEFFname,kind,accountId\r\n');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await csv.arrayBuffer())).toBe(
      '\uFEFFname,kind,accountId\r\n',
    );
    const json = captureDownload('report.json', '{"name":"中文"}');
    expect(json.type).toBe('application/json;charset=utf-8');
    expect(await json.text()).toBe('{"name":"中文"}');
  });
});
