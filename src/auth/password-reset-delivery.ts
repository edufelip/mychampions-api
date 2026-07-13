import type { ServerConfig } from '../config';

export type PasswordResetDeliveryInput = {
  requestId: string;
  emailNormalized: string;
  resetUrl: string;
  expiresAt: string;
};

export type PasswordResetDeliveryGateway = {
  send(input: PasswordResetDeliveryInput): Promise<void>;
};

export type PasswordResetDeliveryGatewayErrorCode = 'configuration' | 'provider_error';

export class PasswordResetDeliveryGatewayError extends Error {
  readonly code: PasswordResetDeliveryGatewayErrorCode;

  constructor(code: PasswordResetDeliveryGatewayErrorCode, message: string) {
    super(message);
    this.name = 'PasswordResetDeliveryGatewayError';
    this.code = code;
  }
}

export function createPasswordResetDeliveryGateway(
  _config: ServerConfig
): PasswordResetDeliveryGateway | undefined {
  return undefined;
}
