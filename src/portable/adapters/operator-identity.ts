import type { PortableConfig } from "../config";
import type { OperatorIdentity, OperatorPrincipal } from "../contracts";
import { timingSafeTextEqual } from "../security/crypto";

export class ProxyOperatorIdentity implements OperatorIdentity {
  constructor(private readonly config: PortableConfig) {}

  authenticate(headers: Headers): Promise<OperatorPrincipal | null> {
    const email = headers.get(this.config.OIDC_EMAIL_HEADER)?.trim().toLowerCase();
    const providedSecret = headers.get(this.config.OIDC_TRUST_HEADER);
    if (!email && !providedSecret) return Promise.resolve(null);
    if (
      !email ||
      !providedSecret ||
      !this.config.OIDC_TRUST_SECRET ||
      !timingSafeTextEqual(providedSecret, this.config.OIDC_TRUST_SECRET)
    ) {
      return Promise.reject(new Error("untrusted_operator_identity_headers"));
    }
    return Promise.resolve({ email });
  }

  check(): Promise<void> {
    if (this.config.DEPLOYMENT_MODE === "managed" && !this.config.OIDC_TRUST_SECRET) {
      return Promise.reject(new Error("operator_identity_not_configured"));
    }
    return Promise.resolve();
  }
}
