import { randomBytes } from "node:crypto";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";

export const CONNECTOR_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface IssuedConnectorPairingCode {
  code: string;
  expiresAt: string;
}

/** 登录态设备接入的唯一签发入口；存储与后续核销仍归既有 connector registry。 */
export class IssueConnectorPairingCode {
  constructor(
    private readonly repo: ConnectorRegistryRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(): Promise<IssuedConnectorPairingCode> {
    const issuedAtMs = this.now();
    const code = Array.from(randomBytes(8))
      .map(byte => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length])
      .join("");
    const expiresAt = new Date(issuedAtMs + CONNECTOR_PAIRING_CODE_TTL_MS).toISOString();
    await this.repo.createPairingCode(code, expiresAt);
    return { code, expiresAt };
  }
}
