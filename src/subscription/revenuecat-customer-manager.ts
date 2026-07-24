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
  timeoutMs?: number;
};

const MAX_PROVIDER_OBSERVATION_SKEW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CUSTOMER_LOOKUP_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidSubscriberCollection(message: string): never {
  throw new RevenueCatCustomerManagerError('invalid_response', message);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function validateOptionalDate(
  value: Record<string, unknown>,
  field: string,
  description: string
): void {
  if (
    Object.prototype.hasOwnProperty.call(value, field) &&
    value[field] !== null &&
    parseDate(value[field]) === null
  ) {
    invalidSubscriberCollection(
      `RevenueCat customer response has a malformed ${description} ${field}.`
    );
  }
}

function readCanonicalSubscriberCollections(subscriber: Record<string, unknown>): {
  entitlements: Record<string, unknown>;
  subscriptions: Record<string, unknown>;
} {
  if (!isRecord(subscriber.entitlements) || !isRecord(subscriber.subscriptions)) {
    return invalidSubscriberCollection(
      'RevenueCat customer response is missing canonical entitlement or subscription collections.'
    );
  }

  for (const [entitlementId, entitlement] of Object.entries(subscriber.entitlements)) {
    if (!isRecord(entitlement)) {
      invalidSubscriberCollection(
        `RevenueCat customer response has a malformed entitlement entry for ${entitlementId}.`
      );
    }
    if (!Object.prototype.hasOwnProperty.call(entitlement, 'expires_date')) {
      invalidSubscriberCollection(
        `RevenueCat customer response has an incomplete entitlement entry for ${entitlementId}.`
      );
    }
    validateOptionalDate(entitlement, 'expires_date', `entitlement ${entitlementId}`);
    validateOptionalDate(
      entitlement,
      'grace_period_expires_date',
      `entitlement ${entitlementId}`
    );
    if (
      typeof entitlement.product_identifier !== 'string' ||
      !entitlement.product_identifier.trim()
    ) {
      invalidSubscriberCollection(
        `RevenueCat customer response has an invalid product identifier for entitlement ${entitlementId}.`
      );
    }
  }

  for (const [productIdentifier, subscription] of Object.entries(subscriber.subscriptions)) {
    if (!isRecord(subscription)) {
      invalidSubscriberCollection(
        `RevenueCat customer response has a malformed subscription entry for ${productIdentifier}.`
      );
    }
    validateOptionalDate(
      subscription,
      'billing_issues_detected_at',
      `subscription ${productIdentifier}`
    );
    validateOptionalDate(subscription, 'refunded_at', `subscription ${productIdentifier}`);
    validateOptionalDate(
      subscription,
      'unsubscribe_detected_at',
      `subscription ${productIdentifier}`
    );
  }

  return {
    entitlements: subscriber.entitlements,
    subscriptions: subscriber.subscriptions,
  };
}

function readObservedDate(customer: RawRevenueCatCustomer, now: Date): Date {
  const isWithinTrustedWindow = (candidate: Date) =>
    Number.isFinite(candidate.getTime()) &&
    Math.abs(candidate.getTime() - now.getTime()) <= MAX_PROVIDER_OBSERVATION_SKEW_MS;

  if (typeof customer.request_date_ms === 'number' && Number.isFinite(customer.request_date_ms)) {
    const requestDateMs = new Date(customer.request_date_ms);
    if (isWithinTrustedWindow(requestDateMs)) return requestDateMs;
  }

  const requestDate = parseDate(customer.request_date);
  return requestDate && isWithinTrustedWindow(requestDate) ? requestDate : now;
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

  const { entitlements, subscriptions } = readCanonicalSubscriberCollections(
    customer.subscriber
  );
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
  private readonly timeoutMs: number;

  constructor(
    private readonly secretApiKey: string,
    deps: RevenueCatRestCustomerManagerDeps = {}
  ) {
    this.apiBaseUrl = (deps.apiBaseUrl ?? 'https://api.revenuecat.com/v1').replace(/\/+$/, '');
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs =
      typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
        ? deps.timeoutMs
        : DEFAULT_CUSTOMER_LOOKUP_TIMEOUT_MS;
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

    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(
          new RevenueCatCustomerManagerError(
            'network',
            'RevenueCat customer lookup exceeded its deadline.'
          )
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race(
        [
          this.fetchCustomerPrivileges(
            normalizedAppUserId,
            abortController.signal
          ),
          deadline,
        ]
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async fetchCustomerPrivileges(
    appUserId: string,
    signal: AbortSignal
  ): Promise<RevenueCatCustomerPrivileges> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.apiBaseUrl}/subscribers/${encodeURIComponent(appUserId)}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.secretApiKey.trim()}`,
            accept: 'application/json',
          },
          signal,
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
    } catch (error) {
      if (signal.aborted) {
        throw new RevenueCatCustomerManagerError(
          'network',
          'RevenueCat customer response exceeded its deadline.'
        );
      }
      throw new RevenueCatCustomerManagerError(
        'invalid_response',
        'RevenueCat customer lookup returned invalid JSON.'
      );
    }

    return mapRevenueCatCustomerPrivileges(body, appUserId, this.now());
  }
}
