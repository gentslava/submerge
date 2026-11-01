export function dnsAnswer(query: Buffer): Buffer {
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([
    header,
    query.subarray(12),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 198, 19, 0, 5]),
  ]);
}
