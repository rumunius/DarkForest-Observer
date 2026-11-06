/** Prefer UTF-8; Chinese Windows Excel can also save CSV using its legacy encoding. */
export async function readAccountCsv(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('无法识别CSV文件编码，请在Excel中另存为“CSV UTF-8（逗号分隔）”后重试。');
    }
  }
}

/** RFC 4180 field parsing. Imported data is never evaluated as spreadsheet formulas. */
export function accountCsv(source: string): { name: string; kind: string; accountId?: string }[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      if (cell) throw new Error('CSV引号只能从字段开头开始。');
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('CSV文件有未闭合的引号。');
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);
  const header = rows.shift();
  if (!header || header.join(',') !== 'name,kind,accountId')
    throw new Error('请选择含name、kind、accountId三列表头的账号模板。');
  return rows.map((r, i) => {
    if (r.length !== 3) throw new Error(`第${i + 2}行的列数不正确。`);
    return { name: r[0]!, kind: r[1]!, ...(r[2] ? { accountId: r[2] } : {}) };
  });
}
