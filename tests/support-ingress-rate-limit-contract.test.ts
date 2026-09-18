import { describe, expect, it } from 'bun:test';

const repositoryRoot = new URL('..', import.meta.url);

async function read(relativePath: string) {
  return Bun.file(new URL(relativePath, repositoryRoot)).text();
}

describe('support ingress rate-limit contract', () => {
  it('uses Nginx socket addresses for an http-context per-IP support guard', async () => {
    const config = await read('infra/nginx/mychampions-server-rate-limits.conf');

    expect(config).toContain('limit_req_zone $binary_remote_addr');
    expect(config).toContain('zone=mychampions_support_per_ip:10m');
    expect(config).toContain('rate=30r/m');
    expect(config).not.toContain('$http_x_forwarded_for');
  });

  it('attaches the higher ingress guard only to the support message route', async () => {
    const template = await read('infra/nginx/mychampions-server.conf');

    expect(template).toContain('location = /support/messages');
    expect(template).toContain('limit_req zone=mychampions_support_per_ip burst=10 nodelay;');
    expect(template).toContain('limit_req_status 429;');
    expect(template).toContain('proxy_set_header X-Real-IP $remote_addr;');
  });

  it('installs the http-context configuration before validating production ingress', async () => {
    const [bootstrap, deploy] = await Promise.all([
      read('infra/scripts/bootstrap-public-ingress.sh'),
      read('infra/scripts/deploy-vm.sh'),
    ]);

    for (const script of [bootstrap, deploy]) {
      expect(script).toContain('mychampions-server-rate-limits.conf');
      expect(script).toContain('nginx_rate_limit_destination');
      expect(script).toContain('install -m 644 "$nginx_rate_limit_config" "$nginx_rate_limit_destination"');
      expect(script.indexOf('nginx_rate_limit_destination')).toBeLessThan(script.indexOf('nginx -t'));
    }
  });
});
