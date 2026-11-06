import type { GameEvent } from '@darkforest/contracts';

export function personalMessage(event: GameEvent, playerId?: string) {
  return event.audience === 'personal' && (!event.recipient || event.recipient === playerId);
}
