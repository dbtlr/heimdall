import type { DeliveryChannel } from './delivery-config.ts';
import type { Message, Send } from './delivery.ts';

const SEND_TIMEOUT_MS = 10_000;

// ntfy's priorities: 4 breaks through Do Not Disturb on Android and is
// time-sensitive on iOS; 2 arrives without sound.
const PRIORITY = { high: 4, low: 2 } as const satisfies Record<Message['priority'], number>;
const TAGS = { high: ['rotating_light'], low: ['white_check_mark'] } as const;

// Sends to the channel's ntfy server as one JSON publish to the server's
// address, so the topic travels in the body and the token in a header; neither
// is part of a URL an error could name. An answer other than 2xx throws with
// its status alone.
export const ntfySender =
  (channel: DeliveryChannel): Send =>
  async (message) => {
    const response = await fetch(channel.url, {
      body: JSON.stringify({
        click: message.click,
        message: message.message,
        priority: PRIORITY[message.priority],
        tags: TAGS[message.priority],
        title: message.title,
        topic: channel.topic,
      }),
      headers: {
        'Content-Type': 'application/json',
        ...(channel.token === undefined ? {} : { Authorization: `Bearer ${channel.token}` }),
      },
      method: 'POST',
      // A redirect would turn the publish into a GET without its body, which
      // a server can answer 200 without publishing anything.
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`The ntfy server answered ${String(response.status)}.`);
    }
  };
