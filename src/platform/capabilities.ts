/**
 * Capability labels for the native platform adapter.
 *
 * A capability is labelled `native` only after an actual signed call to the
 * installed platform succeeded through this adapter instance. Until then it is
 * `unverified`. The UI must not present unverified capabilities as native.
 */

export const PLATFORM_CAPABILITIES = ["identity", "workroom", "rebac", "extensions", "ontology", "knowledge"] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export type CapabilityLabel = "native" | "unverified";

export interface CapabilityStatus {
  capability: PlatformCapability;
  label: CapabilityLabel;
  /** ISO timestamp of the first successful native call, or null. */
  verifiedAt: string | null;
  /** `METHOD /path` of the most recent successful call, or null. */
  lastTarget: string | null;
  /** Platform request id of the most recent successful call, or null. */
  lastRequestId: string | null;
}

export type CapabilitySnapshot = Readonly<Record<PlatformCapability, CapabilityStatus>>;

export interface CapabilityEvidence {
  target: string;
  requestId: string | null;
  at?: string;
}

export class CapabilityRegistry {
  private readonly status: Record<PlatformCapability, CapabilityStatus>;

  constructor() {
    this.status = Object.fromEntries(
      PLATFORM_CAPABILITIES.map((c) => [
        c,
        { capability: c, label: "unverified", verifiedAt: null, lastTarget: null, lastRequestId: null } satisfies CapabilityStatus,
      ]),
    ) as Record<PlatformCapability, CapabilityStatus>;
  }

  /** Record a successful native call. Only the adapter calls this. */
  markNative(capability: PlatformCapability, evidence: CapabilityEvidence): void {
    const at = evidence.at ?? new Date().toISOString();
    const current = this.status[capability];
    this.status[capability] = {
      capability,
      label: "native",
      verifiedAt: current.verifiedAt ?? at,
      lastTarget: evidence.target,
      lastRequestId: evidence.requestId,
    };
  }

  isNative(capability: PlatformCapability): boolean {
    return this.status[capability].label === "native";
  }

  snapshot(): CapabilitySnapshot {
    const copy = {} as Record<PlatformCapability, CapabilityStatus>;
    for (const c of PLATFORM_CAPABILITIES) copy[c] = { ...this.status[c] };
    return Object.freeze(copy);
  }
}
