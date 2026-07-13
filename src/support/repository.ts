export type SupportMessageStatus = 'pending' | 'reviewed' | 'resolved';
export type SupportPlatform = 'ios' | 'android' | 'web';

export type CreateSupportMessageInput = {
  authUid: string;
  userEmail: string;
  userName: string;
  userRole: string;
  subject: string;
  body: string;
  appVersion: string;
  platform: SupportPlatform;
};

export type SupportMessage = CreateSupportMessageInput & {
  id: string;
  status: SupportMessageStatus;
  createdAt: string;
  updatedAt: string;
};

export interface SupportMessageRepository {
  create(input: CreateSupportMessageInput): Promise<SupportMessage>;
}
