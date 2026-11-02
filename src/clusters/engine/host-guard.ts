import { BadRequestException } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/**
 * Refuses hosts that resolve to private, loopback, link-local or metadata
 * addresses, so the API cannot be used to reach its own network. Local
 * databases go through the agent instead.
 */
export async function assertPublicHost(host: string): Promise<void> {
  const trimmed = (host || '').trim().replace(/^\[|\]$/g, '');
  if (!trimmed) throw new BadRequestException('Host is required.');

  let addresses: string[];
  try {
    addresses = isIP(trimmed)
      ? [trimmed]
      : (await lookup(trimmed, { all: true, verbatim: true })).map(
          (a) => a.address,
        );
  } catch {
    throw new BadRequestException(`Could not resolve host "${trimmed}".`);
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new BadRequestException(
      `"${trimmed}" is a private or local address. To connect a database on your own machine or network, enable "Local database" and run the synqdb-agent.`,
    );
  }
}
