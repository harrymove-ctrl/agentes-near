import net from "node:net";
import path from "node:path";
import { parsePlist } from "../../runner/usbmux";

export interface FakeDevice {
  id: number;
  serial: string;
  type?: "USB" | "Network";
}

/**
 * usbmuxd on a Unix socket in `dir`: `ListDevices` answers `devices`, a `Connect` to a phone port in `ports` pipes the
 * socket to that loopback port (any other port is refused). `asked` keeps every message.
 */
export async function fakeUsbmuxd(dir: string, devices: FakeDevice[], ports: Record<number, number>) {
  const file = path.join(dir, "usbmuxd.sock");
  const asked: Record<string, unknown>[] = [];
  const reply = (sock: net.Socket, tag: number, xml: string) => {
    const body = Buffer.from(`<?xml version="1.0"?><plist version="1.0">${xml}</plist>`);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + body.length, 0);
    head.writeUInt32LE(1, 4);
    head.writeUInt32LE(8, 8);
    head.writeUInt32LE(tag, 12);
    sock.write(Buffer.concat([head, body]));
  };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const length = buf.readUInt32LE(0);
      const tag = buf.readUInt32LE(12);
      const msg = parsePlist(buf.subarray(16, length).toString("utf8")) as Record<string, unknown>;
      buf = buf.subarray(length);
      asked.push(msg);
      if (msg.MessageType === "ListDevices") {
        const list = devices
          .map(
            (d) =>
              `<dict><key>DeviceID</key><integer>${d.id}</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>${d.type ?? "USB"}</string><key>DeviceID</key><integer>${d.id}</integer><key>SerialNumber</key><string>${d.serial}</string></dict></dict>`,
          )
          .join("");
        reply(sock, tag, `<dict><key>DeviceList</key><array>${list}</array></dict>`);
        return;
      }
      const raw = Number(msg.PortNumber);
      const port = ((raw & 0xff) << 8) | (raw >> 8);
      const to = ports[port];
      if (msg.MessageType !== "Connect" || !devices.some((d) => d.id === msg.DeviceID) || !to) {
        reply(
          sock,
          tag,
          "<dict><key>MessageType</key><string>Result</string><key>Number</key><integer>3</integer></dict>",
        );
        return;
      }
      sock.off("data", onData);
      sock.pause();
      const phone = net.connect(to, "127.0.0.1", () => {
        reply(
          sock,
          tag,
          "<dict><key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer></dict>",
        );
        if (buf.length > 0) phone.write(buf);
        sock.pipe(phone).pipe(sock);
        sock.resume();
      });
      const close = () => {
        sock.destroy();
        phone.destroy();
      };
      phone.on("error", close).on("close", close);
      sock.on("error", close).on("close", close);
    };
    sock.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return { file, asked, close: () => server.close() };
}

/** A free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
