import type {GameEvent} from '@darkforest/contracts';

/** 按事件受众和当前文明判断是否属于个人消息，供未读提示使用。 */
export function personalMessage(event: GameEvent, playerId?: string) {
  return (
    event.audience === 'personal' &&
    (!event.recipient || event.recipient === playerId)
  );
}
