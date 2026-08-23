import type { Credential, OxaBroker, RequestCredentialParams } from './types';

/**
 * JSON-serialize a payload, converting bigint values to strings
 * (JSON.stringify throws on bigint by default).
 */
function serializeJson(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export interface HttpOxaBrokerOptions {
  baseUrl: string;
}

/**
 * Talks to the OXA Broker's own HTTP API only — no chain logic here.
 */
export class HttpOxaBroker implements OxaBroker {
  private readonly baseUrl: string;

  constructor(options: HttpOxaBrokerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async requestCredential(params: RequestCredentialParams): Promise<Credential> {
    const response = await fetch(`${this.baseUrl}/request-credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeJson(params),
    });
    if (!response.ok) {
      throw new Error(
        `request-credential failed: HTTP ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    }
    return (await response.json()) as Credential;
  }

  async reclaimExpired(commitmentHash: string): Promise<{ txHash: string }> {
    const response = await fetch(`${this.baseUrl}/reclaim-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serializeJson({ commitmentHash }),
    });
    if (!response.ok) {
      throw new Error(
        `reclaim-expired failed: HTTP ${response.status} ${response.statusText}: ${await response.text()}`,
      );
    }
    return (await response.json()) as { txHash: string };
  }
}
