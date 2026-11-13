import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { parsePlist, plistXml, usbmuxDeviceId, usbmuxForward, usbmuxFrame } from "../../runner/usbmux";
import { fakeUsbmuxd } from "./fake-usbmuxd";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  removeDirs(dirs);
});

const UDID = "00008110-000A1B2C3D4E5F60";

test("plists: what usbmuxd is asked, and what it answers (nested, escaped, every type)", () => {
  const xml = plistXml({ MessageType: "Connect", DeviceID: 7, ProgName: "a&b <c>" });
  expect(parsePlist(xml)).toEqual({ MessageType: "Connect", DeviceID: 7, ProgName: "a&b <c>" });
  expect(
    parsePlist(`<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DeviceList</key>
  <array>
    <dict>
      <key>Properties</key>
      <dict><key>SerialNumber</key><string>${UDID}</string><key>USB</key><true/><key>Speed</key><real>480.5</real></dict>
      <key>Blob</key><data>aGk=</data>
      <key>Empty</key><string/>
    </dict>
  </array>
</dict>
</plist>`),
  ).toEqual({
    DeviceList: [{ Properties: { SerialNumber: UDID, USB: true, Speed: 480.5 }, Blob: Buffer.from("hi"), Empty: "" }],
  });
  expect(() => parsePlist("<plist><dict><key>a</key></dict></plist>")).toThrow();
  const frame = usbmuxFrame({ MessageType: "ListDevices" }, 9);
  expect([frame.readUInt32LE(0), frame.readUInt32LE(4), frame.readUInt32LE(8), frame.readUInt32LE(12)]).toEqual([
    frame.length,
    1,
    8,
    9,
  ]);
  expect(parsePlist(frame.subarray(16).toString())).toMatchObject({ MessageType: "ListDevices", kLibUSBMuxVersion: 3 });
});

test("a port on the iPhone: found by its UDID over the cable only, reached through a port on this Mac", async () => {
  const dir = tempDir("usbmux-");
  dirs.push(dir);
  const echo = net.createServer((s) =>
    s.on("data", (d) => s.write(Buffer.concat([Buffer.from("phone:"), d as Buffer]))),
  );
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  closers.push(() => echo.close());
  const mux = await fakeUsbmuxd(
    dir,
    [
      { id: 3, serial: "00008110000A1B2C3D4E5F60" },
      { id: 4, serial: "00008030-AAAA", type: "Network" },
    ],
    { 8100: (echo.address() as net.AddressInfo).port },
  );
  closers.push(mux.close);
  // usbmuxd may print the UDID without its dash; one over Wi-Fi isn't on the cable.
  expect(await usbmuxDeviceId(UDID, mux.file)).toBe(3);
  expect(await usbmuxDeviceId("00008030-AAAA", mux.file)).toBe(null);
  const fwd = await usbmuxForward(UDID, 8100, mux.file);
  closers.push(fwd.close);
  const said = await new Promise<string>((resolve) => {
    const c = net.connect(fwd.port, "127.0.0.1", () => c.write("ping"));
    c.on("data", (d) => {
      resolve(d.toString());
      c.destroy();
    });
  });
  expect(said).toBe("phone:ping");
  // The port goes in network byte order.
  expect(mux.asked.find((m) => m.MessageType === "Connect")).toMatchObject({ DeviceID: 3, PortNumber: 0xa41f });
  // A port nothing listens on: the client is hung up on.
  const refused = await usbmuxForward(UDID, 9100, mux.file);
  closers.push(refused.close);
  const closed = await new Promise<boolean>((resolve) => {
    const c = net.connect(refused.port, "127.0.0.1");
    c.on("close", () => resolve(true));
    c.on("error", () => resolve(true));
  });
  expect(closed).toBe(true);
  // No phone by that UDID on the cable.
  expect(await errorCode(() => usbmuxForward("00008030-AAAA", 8100, mux.file))).toBe("phone_missing");
});
