import { describe, expect, it } from 'bun:test';

import {
  createPasswordResetDeliveryGateway,
} from '../src/auth/password-reset-delivery';
import { readConfig } from '../src/config';

describe('password reset delivery gateway', () => {
  it('does not enable a remote reset provider from retired provider flags', () => {
    const gateway = createPasswordResetDeliveryGateway(
      readConfig({ SUPABASE_AUTH_ENABLED: 'true' })
    );

    expect(gateway).toBeUndefined();
  });
});
