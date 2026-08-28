/**
 * Persistent store for credential secrets the Broker holds in custody on the
 * issuer's behalf (Decision 0001 Design B custodial scope; Blueprint §2.6).
 *
 * The credential_secret/reclaim_secret pair is needed later for Reclaim of an
 * expired credential and never exists on-chain (only commitments do). They are
 * written to broker/.data/credentials.json AFTER a mint transaction confirms.
 * That directory is gitignored — this file is part of the secrets surface, not
 * a commit candidate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname, '..', '.data');
const STORE_FILE = join(DATA_DIR, 'credentials.json');

export interface StoredCredential {
  commitmentHash: string;
  credentialSecret: string;
  reclaimSecret: string;
  endpointId: string;
  /** Raw token units (u128), as bigint string to avoid precision loss in JSON. */
  amount: string;
  expiryTimestamp: number;
  createdAt: number;
  used: boolean;
}

export function loadCredentials(): Record<string, StoredCredential> {
  if (!existsSync(STORE_FILE)) return {};
  return JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Record<string, StoredCredential>;
}

export function saveCredential(entry: StoredCredential): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const all = loadCredentials();
  all[entry.commitmentHash] = entry;
  writeFileSync(STORE_FILE, JSON.stringify(all, null, 2));
}

export function markUsed(commitmentHash: string): void {
  const all = loadCredentials();
  const entry = all[commitmentHash];
  if (entry !== undefined) {
    entry.used = true;
    writeFileSync(STORE_FILE, JSON.stringify(all, null, 2));
  }
}

export function getCredential(commitmentHash: string): StoredCredential | undefined {
  return loadCredentials()[commitmentHash];
}