import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundDestination,
  assertSafeOutboundUrl,
  isPrivateOrReservedAddress
} from "@loyalty-interchange/server";

describe("outbound URL policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "::1",
    "fd00::1",
    "fe80::1"
  ])("classifies %s as non-public", (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "classifies %s as public",
    (address) => {
      expect(isPrivateOrReservedAddress(address)).toBe(false);
    }
  );

  it("rejects private literals, local names, credentials, fragments, and public HTTP", () => {
    for (const value of [
      "https://127.0.0.1/hooks",
      "https://169.254.169.254/latest/meta-data",
      "https://service.internal/hooks",
      "https://user:password@receiver.example/hooks",
      "https://receiver.example/hooks#fragment",
      "http://receiver.example/hooks"
    ]) {
      expect(() => assertSafeOutboundUrl(value)).toThrow();
    }
  });

  it("rejects a public hostname when any DNS answer is private", async () => {
    await expect(assertSafeOutboundDestination("https://receiver.example/hooks", {
      resolver: async () => ["203.0.113.10", "10.0.0.5"]
    })).rejects.toThrow(/private|reserved/);
  });

  it("accepts public HTTPS and an explicit private-network development opt-in", async () => {
    await expect(assertSafeOutboundDestination("https://receiver.example/hooks", {
      resolver: async () => ["8.8.8.8"]
    })).resolves.toBeInstanceOf(URL);
    expect(assertSafeOutboundUrl("http://127.0.0.1:4000/hooks", {
      allowPrivateNetworks: true
    }).hostname).toBe("127.0.0.1");
  });
});
