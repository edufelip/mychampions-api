export const REVENUECAT_PRO_ENTITLEMENT_ID = 'professional_pro';
export const REVENUECAT_AI_ENTITLEMENT_ID = 'student_pro';

export type RevenueCatEntitlementStatus = 'active' | 'lapsed';

export type RevenueCatCustomerPrivileges = {
  appUserId: string;
  professionalEntitlementStatus: RevenueCatEntitlementStatus;
  aiEntitlementStatus: RevenueCatEntitlementStatus;
  professionalEntitlementExpiresAt: string | null;
  professionalEntitlementRenewalRisk: boolean;
  observedAt: string;
};

export interface RevenueCatCustomerManager {
  getCustomerPrivileges(appUserId: string): Promise<RevenueCatCustomerPrivileges>;
}

export type RevenueCatCustomerManagerErrorCode =
  | 'configuration'
  | 'network'
  | 'upstream'
  | 'invalid_response';

export class RevenueCatCustomerManagerError extends Error {
  constructor(
    readonly code: RevenueCatCustomerManagerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RevenueCatCustomerManagerError';
  }
}

type RawRevenueCatEntitlement = {
  expires_date?: unknown;
  grace_period_expires_date?: unknown;
  product_identifier?: unknown;
};

type RawRevenueCatSubscription = {
  billing_issues_detected_at?: unknown;
  refunded_at?: unknown;
  unsubscribe_detected_at?: unknown;
};

type RawRevenueCatCustomer = {
  request_date?: unknown;
  request_date_ms?: unknown;
  subscriber?: {
    entitlements?: unknown;
    subscriptions?: unknown;
  };
};

type RevenueCatRestCustomerManagerDeps = {
  apiBaseUrl?: string;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function readObservedDate(customer: RawRevenueCatCustomer, now: Date): Date {
  if (typeof customer.request_date_ms === 'number' && Number.isFinite(customer.request_date_ms)) {
    const requestDateMs = new Date(customer.request_date_ms);
    if (Number.isFinite(requestDateMs.getTime())) return requestDateMs;
  }

  const requestDate = parseDate(customer.request_date);
  return requestDate ?? now;
}

function readEntitlement(
  entitlements: Record<string, unknown>,
  entitlementId: string
): RawRevenueCatEntitlement | null {
  const entitlement = entitlements[entitlementId];
  return isRecord(entitlement) ? entitlement : null;
}

function effectiveExpiration(entitlement: RawRevenueCatEntitlement): Date | null {
  const expiration = parseDate(entitlement.expires_date);
  const gracePeriodExpiration = parseDate(entitlement.grace_period_expires_date);
  if (!expiration) return gracePeriodExpiration;
  if (!gracePeriodExpiration) return expiration;
  return gracePeriodExpiration > expiration ? gracePeriodExpiration : expiration;
}

function isEntitlementActive(entitlement: RawRevenueCatEntitlement | null, now: Date): boolean {
  if (!entitlement) return false;
  if (!Object.prototype.hasOwnProperty.call(entitlement, 'expires_date')) return false;
  if (entitlement.expires_date !== null && parseDate(entitlement.expires_date) === null) return false;
  if (
    entitlement.grace_period_expires_date !== undefined &&
    entitlement.grace_period_expires_date !== null &&
    parseDate(entitlement.grace_period_expires_date) === null
  ) {
    return false;
  }
  const expiration = effectiveExpiration(entitlement);
  return expiration === null || expiration > now;
}

function readSubscription(
  subscriptions: Record<string, unknown>,
  entitlement: RawRevenueCatEntitlement | null
): RawRevenueCatSubscription | null {
  const productIdentifier = entitlement?.product_identifier;
  if (typeof productIdentifier !== 'string' || !productIdentifier.trim()) return null;
  const subscription = subscriptions[productIdentifier];
  return isRecord(subscription) ? subscription : null;
}

function hasTimestamp(value: unknown): boolean {
  return parseDate(value) !== null;
}

function hasActiveEntitlement(
  entitlement: RawRevenueCatEntitlement | null,
  subscription: RawRevenueCatSubscription | null,
  now: Date
): boolean {
  return isEntitlementActive(entitlement, now) && !hasTimestamp(subscription?.refunded_at);
}

export function mapRevenueCatCustomerPrivileges(
  customer: unknown,
  appUserId: string,
  now: Date = new Date()
): RevenueCatCustomerPrivileges {
  if (!isRecord(customer) || !isRecord(customer.subscriber)) {
    throw new RevenueCatCustomerManagerError(
      'invalid_response',
      'RevenueCat customer response is missing subscriber data.'
    );
  }

  const entitlements = isRecord(customer.subscriber.entitlements)
    ? customer.subscriber.entitlements
    : {};
  const subscriptions = isRecord(customer.subscriber.subscriptions)
    ? customer.subscriber.subscriptions
    : {};
  const professionalEntitlement = readEntitlement(entitlements, REVENUECAT_PRO_ENTITLEMENT_ID);
  const aiEntitlement = readEntitlement(entitlements, REVENUECAT_AI_ENTITLEMENT_ID);
  const professionalSubscription = readSubscription(subscriptions, professionalEntitlement);
  const aiSubscription = readSubscription(subscriptions, aiEntitlement);
  const observedAt = readObservedDate(customer as RawRevenueCatCustomer, now);
  const professionalActive = hasActiveEntitlement(
    professionalEntitlement,
    professionalSubscription,
    observedAt
  );
  const professionalExpiration = professionalEntitlement
    ? effectiveExpiration(professionalEntitlement)
    : null;
  const professionalEntitlementStatus = professionalActive ? 'active' : 'lapsed';
  const professionalEntitlementRenewalRisk =
    professionalEntitlementStatus === 'active' &&
    (hasTimestamp(professionalSubscription?.billing_issues_detected_at) ||
      hasTimestamp(professionalSubscription?.unsubscribe_detected_at));

  return {
    appUserId,
    professionalEntitlementStatus,
    aiEntitlementStatus: hasActiveEntitlement(aiEntitlement, aiSubscription, observedAt)
      ? 'active'
      : 'lapsed',
    professionalEntitlementExpiresAt: professionalExpiration?.toISOString() ?? null,
    professionalEntitlementRenewalRisk,
    observedAt: observedAt.toISOString(),
  };
}

export class RevenueCatRestCustomerManager implements RevenueCatCustomerManager {
  private readonly apiBaseUrl: string;
  private readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;

  constructor(
    private readonly secretApiKey: string,
    deps: RevenueCatRestCustomerManagerDeps = {}
  ) {
    this.apiBaseUrl = (deps.apiBaseUrl ?? 'https://api.revenuecat.com/v1').replace(/\/+$/, '');
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  async getCustomerPrivileges(appUserId: string): Promise<RevenueCatCustomerPrivileges> {
    const normalizedAppUserId = appUserId.trim();
    if (!normalizedAppUserId) {
      throw new RevenueCatCustomerManagerError(
        'configuration',
        'RevenueCat customer lookup requires a nonblank App User ID.'
      );
    }
    if (!this.secretApiKey.trim().toLowerCase().startsWith('sk_')) {
      throw new RevenueCatCustomerManagerError(
        'configuration',
        'RevenueCat customer lookup requires a server-only sk_* secret API key.'
      );
    }

    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.apiBaseUrl}/subscribers/${encodeURIComponent(normalizedAppUserId)}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.secretApiKey.trim()}`,
            accept: 'application/json',
          },
        }
      );
    } catch (error) {
      throw new RevenueCatCustomerManagerError(
        'network',
        `RevenueCat customer lookup failed: ${String(error)}`
      );
    }

    if (!response.ok) {
      throw new RevenueCatCustomerManagerError(
        'upstream',
        `RevenueCat customer lookup failed with status ${response.status}.`
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RevenueCatCustomerManagerError(
        'invalid_response',
        'RevenueCat customer lookup returned invalid JSON.'
      );
    }

    return mapRevenueCatCustomerPrivileges(body, normalizedAppUserId, this.now());
  }
}
