import type {Arms, ColorId} from '@darkforest/contracts';

/** Move one bracelet atomically; a full requested arm spills into the other arm. */
export function moveBracelet(
  arms: Arms,
  id: ColorId,
  requested: number | null,
) {
  const next = arms.map(arm => arm.filter(color => color !== id)) as Arms;
  let target = requested;
  if (target !== null) {
    if (next.flat().length >= 4) {
      return {error: '最多选择4条手环。'} as const;
    }
    if (next[target]!.length >= 3) {
      target = target === 0 ? 1 : 0;
    }
    if (next[target]!.length >= 3) {
      return {error: '每侧最多选择3条。'} as const;
    }
    next[target]!.push(id);
  }
  return {arms: next, target, overflow: target !== requested} as const;
}
