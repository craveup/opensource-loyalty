import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type OutboundAddressResolver = (hostname: string) => Promise<readonly string[]>;

export interface SafeOutboundUrlOptions {
  /** Explicit local-development escape hatch. Keep false in networked deployments. */
  allowPrivateNetworks?: boolean;
  /** Set to false only when a trusted injected transport enforces its own DNS policy. */
  resolver?: OutboundAddressResolver | false;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function unsafeIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function unsafeIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const first = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
  return (
    !Number.isInteger(first) ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    first >= 0xff00
  );
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return unsafeIpv4(address);
  if (family === 6) return unsafeIpv6(address);
  return true;
}

function unsafeHostname(hostname: string): boolean {
  if (!hostname || !hostname.includes(".")) return true;
  return [
    "localhost",
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".lan",
    ".home.arpa"
  ].some((suffix) => hostname === suffix.replace(/^\./, "") || hostname.endsWith(suffix));
}

export function assertSafeOutboundUrl(
  input: string | URL,
  options: SafeOutboundUrlOptions = {}
): URL {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  const hostname = normalizedHostname(url);
  const allowPrivate = options.allowPrivateNetworks === true;
  if (url.username || url.password || url.hash) {
    throw new Error("Outbound URL must not contain credentials or a fragment");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("Outbound URL must use HTTPS; HTTP is development-only for explicitly allowed private networks");
  }
  if (!allowPrivate) {
    const family = isIP(hostname);
    if ((family > 0 && isPrivateOrReservedAddress(hostname)) || (family === 0 && unsafeHostname(hostname))) {
      throw new Error("Outbound URL must use a public network destination");
    }
  }
  return url;
}

export const resolveHostAddresses: OutboundAddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
};

export async function assertSafeOutboundDestination(
  input: string | URL,
  options: SafeOutboundUrlOptions = {}
): Promise<URL> {
  const url = assertSafeOutboundUrl(input, options);
  if (options.allowPrivateNetworks === true) return url;
  const hostname = normalizedHostname(url);
  if (isIP(hostname) > 0) return url;
  const resolver = options.resolver === undefined ? resolveHostAddresses : options.resolver;
  if (resolver === false) return url;
  const addresses = await resolver(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) {
    throw new Error("Outbound URL resolved to a private, reserved, or unavailable destination");
  }
  return url;
}
