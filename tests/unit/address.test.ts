import { describe, expect, it } from "vitest";
import { generateLocalPart, generateToken, hashToken, isValidLocalPart, timingSafeEqualHex } from "../../src/lib/address";

describe("address", () => {
  it("ローカル部は指定文字集合の10文字", () => {
    for (let index = 0; index < 100; index += 1) expect(generateLocalPart()).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{10}$/);
  });
  it("ローカル部の形式を検証する", () => {
    expect(isValidLocalPart("abcdefgh23")).toBe(true);
    expect(isValidLocalPart("abcde0gh23")).toBe(false);
  });
  it("tokenは32byte相当のbase64url", () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("tokenをSHA-256 hex化する", async () => {
    expect(await hashToken("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("hexを長さを含めて比較する", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abcd00")).toBe(false);
  });
});
