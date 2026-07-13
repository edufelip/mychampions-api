import { describe, expect, it } from 'bun:test';

import { InMemorySocialIdentityRepository, SocialIdentityService } from '../src/auth/social-identity';

describe('SocialIdentityService', () => {
  it('reuses an Apple identity when a later verified token omits email', async () => {
    const service = new SocialIdentityService(new InMemorySocialIdentityRepository());
    const first = await service.resolve({
      provider: 'apple',
      providerSubject: 'apple-subject',
      email: 'apple-user@example.test',
      displayName: 'Apple User',
      emailVerified: true,
    });

    const returning = await service.resolve({
      provider: 'apple',
      providerSubject: 'apple-subject',
      email: null,
      displayName: null,
      emailVerified: false,
    });

    expect(first.authUid).toStartWith('social_');
    expect(returning).toEqual(first);
  });

  it('rejects a first social identity that does not provide a verified email', async () => {
    const service = new SocialIdentityService(new InMemorySocialIdentityRepository());

    await expect(
      service.resolve({
        provider: 'apple',
        providerSubject: 'apple-subject',
        email: null,
        displayName: null,
        emailVerified: false,
      })
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('does not auto-link identities from different providers that share an email', async () => {
    const service = new SocialIdentityService(new InMemorySocialIdentityRepository());
    const google = await service.resolve({
      provider: 'google',
      providerSubject: 'google-subject',
      email: 'shared@example.test',
      displayName: 'Google User',
      emailVerified: true,
    });
    const apple = await service.resolve({
      provider: 'apple',
      providerSubject: 'apple-subject',
      email: 'shared@example.test',
      displayName: 'Apple User',
      emailVerified: true,
    });

    expect(apple.authUid).not.toBe(google.authUid);
  });
});
