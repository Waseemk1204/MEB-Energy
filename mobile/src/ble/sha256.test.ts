import { bytesEqual, bytesToHex, hexToBytes, hmacSha256, sha256, utf8 } from './sha256';

/** Against the published vectors: FIPS 180-4 for SHA-256, RFC 4231 for HMAC. */
describe('sha256', () => {
  it('hashes the empty message', () => {
    expect(bytesToHex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashes "abc"', () => {
    expect(bytesToHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('hashes a two-block message', () => {
    expect(bytesToHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });

  it('hashes a message that pads across a block boundary', () => {
    // 56 bytes: the length field forces a second block.
    const m = new Uint8Array(56).fill(0x61);
    expect(bytesToHex(sha256(m))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'
    );
  });
});

describe('hmac-sha256', () => {
  it('matches RFC 4231 test case 1', () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(bytesToHex(hmacSha256(key, utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
    );
  });

  it('matches RFC 4231 test case 2', () => {
    expect(bytesToHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });

  it('matches RFC 4231 test case 6, a key longer than a block', () => {
    const key = new Uint8Array(131).fill(0xaa);
    expect(
      bytesToHex(hmacSha256(key, utf8('Test Using Larger Than Block-Size Key - Hash Key First')))
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });
});

describe('helpers', () => {
  it('round-trips hex', () => {
    expect(bytesToHex(hexToBytes('00ff10AB'))).toBe('00ff10ab');
  });

  it('refuses odd or non-hex input', () => {
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });

  it('compares bytes', () => {
    expect(bytesEqual(hexToBytes('0102'), hexToBytes('0102'))).toBe(true);
    expect(bytesEqual(hexToBytes('0102'), hexToBytes('0103'))).toBe(false);
    expect(bytesEqual(hexToBytes('01'), hexToBytes('0102'))).toBe(false);
  });
});
