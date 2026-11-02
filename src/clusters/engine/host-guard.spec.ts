import { assertPublicHost, isPrivateAddress } from './host-guard';

describe('host guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '0.0.0.0',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
  it('rejects hostnames that resolve to loopback', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow(
      /private or local/,
    );
  });
});
