import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { z } from "zod";

const DNS_TIMEOUT_MS = 3000;

export function parseDnsAResponse(message: Buffer, id: number): string[] {
  if (
    message.length < 12 ||
    message.length > 65535 ||
    message.readUInt16BE(0) !== id ||
    (message.readUInt16BE(2) & 0x800f) !== 0x8000 ||
    (message.readUInt16BE(2) & 0x0200) !== 0 ||
    message.readUInt16BE(4) !== 1
  )
    throw new Error("Invalid DNS response");
  let offset = 12;
  const skipName = () => {
    for (let labels = 0; labels < 128; labels++) {
      const length = message[offset];
      if (length === undefined) throw new Error("Truncated DNS name");
      if ((length & 0xc0) === 0xc0) {
        offset += 2;
        return;
      }
      if (length > 63) throw new Error("Invalid DNS label");
      offset += length + 1;
      if (offset > message.length) throw new Error("Truncated DNS label");
      if (length === 0) return;
    }
    throw new Error("Invalid DNS name");
  };
  skipName();
  offset += 4;
  const answers: string[] = [];
  for (let index = 0; index < message.readUInt16BE(6); index++) {
    skipName();
    if (offset + 10 > message.length) throw new Error("Truncated DNS answer");
    const type = message.readUInt16BE(offset);
    const cls = message.readUInt16BE(offset + 2);
    const length = message.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > message.length) throw new Error("Truncated DNS data");
    if (type === 1 && cls === 1 && length === 4)
      answers.push([...message.subarray(offset, offset + 4)].join("."));
    offset += length;
  }
  return z.array(z.ipv4()).min(1).parse(answers);
}

// Uses actual DNS sockets in the caller's network namespace, not API enable flags.
export async function probeDnsListener(
  host: string,
  port: number,
  protocol: "tcp" | "udp",
): Promise<string[]> {
  const id = randomInt(65536);
  const query = Buffer.alloc(12);
  query.writeUInt16BE(id);
  query.writeUInt16BE(0x0100, 2);
  query.writeUInt16BE(1, 4);
  const labels = "example.com"
    .split(".")
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const packet = Buffer.concat([query, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = protocol === "udp" ? createSocket("udp4") : connect({ host, port });
    const finish = (error?: Error, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ("destroy" in socket) socket.destroy();
      else socket.close();
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseDnsAResponse(response ?? Buffer.alloc(0), id));
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`DNS ${protocol} probe timed out`)),
      DNS_TIMEOUT_MS,
    );
    socket.on("error", (error) => finish(error));
    if ("send" in socket) {
      socket.on("message", (response) => finish(undefined, response));
      socket.connect(port, host, () =>
        socket.send(packet, (error) => {
          if (error) finish(error);
        }),
      );
    } else {
      let received = Buffer.alloc(0);
      socket.on("connect", () => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(packet.length);
        socket.write(Buffer.concat([length, packet]));
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 65537) {
          finish(new Error("DNS response too large"));
          return;
        }
        if (received.length >= 2 && received.length >= received.readUInt16BE(0) + 2) {
          finish(undefined, received.subarray(2, received.readUInt16BE(0) + 2));
        }
      });
      socket.on("end", () => {
        if (!settled) finish(new Error("Truncated DNS TCP response"));
      });
    }
  });
}
