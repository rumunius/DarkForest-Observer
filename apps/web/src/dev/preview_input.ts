import {
  COLORS,
  validArms,
  type ColorId,
  type SiteConfig,
} from '@darkforest/contracts';
import {
  ContractError,
  integer,
  object,
  text,
} from '../../../../packages/contracts/src/backend';
import {ApiError} from '../data/http';

function colorList(value: unknown): value is ColorId[] {
  return (
    Array.isArray(value) &&
    value.every(color => COLORS.some(entry => entry.id === color))
  );
}

/** Check unknown preview payloads before passing them to the typed grouping rule. */
export function validPreviewArms(left: unknown, right: unknown): boolean {
  return colorList(left) && colorList(right) && validArms([left, right]);
}

/** A fully checked preview row, read before any simulated batch mutation. */
export interface PreviewElimination {
  id: string;
  reason: string;
}

/** Validate the whole batch first so malformed rows cannot leave partial preview changes. */
export function previewEliminations(value: unknown): PreviewElimination[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ApiError('请核对终局裁决列表。', 422);
  }
  const rows: unknown[] = value;
  try {
    return rows.map(row => {
      const entry = object(row);
      return {
        id: text(entry.id, Number.MAX_SAFE_INTEGER, 0),
        reason: text(entry.reason, Number.MAX_SAFE_INTEGER, 0),
      };
    });
  } catch (error) {
    if (error instanceof ContractError) {
      throw new ApiError('请核对终局裁决列表。', 422);
    }
    throw error;
  }
}

function color(values: Record<string, unknown>, id: ColorId): string {
  const value = text(values[id], 7);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new ContractError('请核对七种颜色设置。');
  }
  return value;
}

/** Validate the public settings contract before replacing the preview configuration. */
export function previewSite(value: unknown): SiteConfig {
  try {
    const site = object(value);
    const colors = object(site.colors);
    return {
      version: integer(site.version, 1),
      title: text(site.title, Number.MAX_SAFE_INTEGER, 0),
      description: text(site.description, Number.MAX_SAFE_INTEGER, 0),
      timezone: text(site.timezone, Number.MAX_SAFE_INTEGER, 0),
      qqGroup: text(site.qqGroup, Number.MAX_SAFE_INTEGER, 0),
      judgeContact: text(site.judgeContact, Number.MAX_SAFE_INTEGER, 0),
      endgameFile: text(site.endgameFile, Number.MAX_SAFE_INTEGER, 0),
      colors: {
        BK: color(colors, 'BK'),
        WH: color(colors, 'WH'),
        GY: color(colors, 'GY'),
        YL: color(colors, 'YL'),
        OR: color(colors, 'OR'),
        SB: color(colors, 'SB'),
        PU: color(colors, 'PU'),
      },
    };
  } catch (error) {
    if (error instanceof ContractError) {
      throw new ApiError('请核对活动设置。', 422);
    }
    throw error;
  }
}
