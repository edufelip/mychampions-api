export type AnalyticsEventName =
  | 'auth.entry.viewed'
  | 'auth.sign_in.submitted'
  | 'auth.sign_in.failed'
  | 'auth.sign_up.submitted'
  | 'auth.sign_up.failed'
  | 'onboarding.role.selected'
  | 'onboarding.self_guided_start.clicked'
  | 'invite.submit.requested'
  | 'invite.submit.failed'
  | 'invite.pending.created'
  | 'invite.pending.canceled'
  | 'invite.pending.confirmed'
  | 'invite.pending.denied'
  | 'invite.pending.bulk_denied';

export type AnalyticsEventProperties = Record<string, unknown>;

export type CreateAnalyticsEventInput = {
  name: AnalyticsEventName;
  properties: AnalyticsEventProperties;
};

export type AnalyticsEvent = CreateAnalyticsEventInput & {
  id: string;
  createdAt: string;
};

export interface AnalyticsEventRepository {
  create(input: CreateAnalyticsEventInput): Promise<AnalyticsEvent>;
}
