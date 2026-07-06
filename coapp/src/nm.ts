// Кадрирование Chrome Native Messaging: 4 байта длины (LE) + JSON в UTF-8.

export function readMessages(onMessage: (msg: unknown) => void): void {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(json));
      } catch {
        // битое сообщение пропускаем
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

export function sendMessage(msg: unknown): void {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}
