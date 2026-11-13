import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactDetail } from "@agenteschat/client";
import {
  decodeFileList,
  driveWebUrl,
  encodeFileList,
  extensionOf,
  extLabel,
  fileInfo,
  pageStep,
  resolveDownloadUrl,
  safeFileName,
  shareSource,
  singleImageHeight,
  utf8Bytes,
  videoClock,
  videoHeight,
  withExtension,
} from "../../src/features/files/logic";
import { clampZoomTranslate, containSize, doubleTapZoom, MAX_ZOOM, zoomAround } from "../../src/features/files/zoom";
import { ICONS } from "../../src/ui/icons.data";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

type Input = Pick<ArtifactDetail, "kind" | "title" | "content">;
const upload = (name: string, contentType: string, size = 1000, text?: string): Input => ({
  kind: "file",
  title: name,
  content: { kind: "file", name, contentType, size, sha256: "x", ...(text !== undefined ? { text } : {}) },
});

describe("videos", () => {
  test("MP4 and MOV play in the app, as a video; other video types stay a card", () => {
    expect(fileInfo(upload("abertura.mp4", "video/mp4"))).toMatchObject({ view: "video", type: "video", ext: "MP4" });
    expect(fileInfo(upload("story.MOV", "video/quicktime")).view).toBe("video");
    expect(fileInfo(upload("antigo.avi", "video/x-msvideo")).view).toBe("other");
  });

  test("one box in a message whatever its shape, so nothing moves once it loads; its time as a clock", () => {
    expect(videoHeight(320)).toBe(180);
    expect(videoClock(7.9)).toBe("0:07");
    expect(videoClock(725)).toBe("12:05");
    expect(videoClock(3729)).toBe("1:02:09");
    expect(videoClock(Number.NaN)).toBe("0:00");
  });
});

describe("file kind, tile and size", () => {
  test("raster pictures are images; SVG is not", () => {
    expect(fileInfo(upload("home.png", "image/png")).view).toBe("image");
    expect(fileInfo(upload("foto.JPG", "image/jpeg; charset=binary")).view).toBe("image");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).view).toBe("other");
    expect(fileInfo(upload("logo.svg", "image/svg+xml")).type).toBe("image");
  });

  test("PDF, Markdown and text open in the document screen", () => {
    const pdf = fileInfo(upload("Relatório.pdf", "application/pdf", 2048));
    expect(pdf).toMatchObject({ view: "pdf", type: "pdf", ext: "PDF", size: 2048, name: "Relatório.pdf" });
    expect(fileInfo(upload("notes.md", "application/octet-stream")).view).toBe("markdown");
    expect(fileInfo(upload("notes.md", "text/markdown")).type).toBe("document");
    const csv = fileInfo(upload("vendas.csv", "text/csv"));
    expect(csv).toMatchObject({ view: "text", type: "table", ext: "CSV" });
    expect(fileInfo(upload("log.txt", "text/plain")).type).toBe("text");
  });

  test("other files are cards with their type", () => {
    expect(fileInfo(upload("backup.zip", "application/zip"))).toMatchObject({
      view: "other",
      type: "archive",
      ext: "ZIP",
    });
    expect(fileInfo(upload("sem-extensao", "application/octet-stream"))).toMatchObject({ type: "file", ext: "" });
  });

  test("a document artifact: title with .md, size from its text", () => {
    const doc = fileInfo({
      kind: "document",
      title: "Resumo da home",
      content: { kind: "document", markdown: "Olá é" },
    });
    expect(doc).toMatchObject({ name: "Resumo da home.md", view: "markdown", type: "document", ext: "MD", size: 7 });
    const table = fileInfo({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } });
    expect(table).toMatchObject({ name: "Vendas.csv", view: "other", type: "table", size: null });
  });

  test("helpers", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf("README")).toBe("");
    expect(extLabel("jpeg")).toBe("JPEG");
    expect(extLabel("markdown")).toBe("MARK");
    expect(withExtension("x.md", "md")).toBe("x.md");
    expect(withExtension("x", "md")).toBe("x.md");
    expect(utf8Bytes("a")).toBe(1);
    expect(utf8Bytes("ç")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("pictures in a message", () => {
  test("a lone picture has one box whatever its shape, so nothing moves once it loads", () => {
    expect(singleImageHeight(300)).toBe(225);
  });
});

describe("shared copies", () => {
  test("safe names: no folders, no refused characters, never empty, extension kept", () => {
    expect(safeFileName("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(safeFileName('a:b*c?"d<e>f|g.png')).toBe("a-b-c--d-e-f-g.png");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("line\nbreak\u0000.txt")).toBe("linebreak.txt");
    expect(safeFileName("   ")).toBe("file");
    const long = safeFileName(`${"a".repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  test("where the copy comes from", () => {
    expect(shareSource({ kind: "document", title: "Plano", content: { kind: "document", markdown: "# Oi" } })).toEqual({
      from: "text",
      text: "# Oi",
      name: "Plano.md",
      mime: "text/markdown",
    });
    expect(
      shareSource({ kind: "table", title: "Vendas", content: { kind: "table", columns: [], rows: [] } }),
    ).toMatchObject({ from: "export", format: "csv", name: "Vendas.csv" });
    expect(shareSource(upload("home/print.png", "image/png"))).toEqual({
      from: "download",
      name: "home-print.png",
      mime: "image/png",
    });
  });

  test("download links: signed links as they are, ours with the session", () => {
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://bucket.s3/x?sig=1")).toEqual({
      uri: "https://bucket.s3/x?sig=1",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat.attacker.test/file")).toEqual({
      uri: "https://app.agentes.chat.attacker.test/file",
      needsSession: false,
    });
    expect(resolveDownloadUrl("https://app.agentes.chat", "https://app.agentes.chat/file")).toEqual({
      uri: "https://app.agentes.chat/file",
      needsSession: true,
    });
    expect(
      resolveDownloadUrl("https://app.agentes.chat/", "/api/app/organizations/o/artifacts/a/file?version=2"),
    ).toEqual({
      uri: "https://app.agentes.chat/api/app/organizations/o/artifacts/a/file?version=2",
      needsSession: true,
    });
  });

  test("the web Drive at the file", () => {
    expect(driveWebUrl("https://app.agentes.chat/", "org1", "a1")).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1",
    );
    expect(driveWebUrl("https://app.agentes.chat", "org1", "a1", 3)).toBe(
      "https://app.agentes.chat/org/org1/drive?artifact=a1&v=3",
    );
  });
});

describe("viewer", () => {
  test("the route's file list round-trips and drops junk", () => {
    const list = [{ id: "a-1", version: 2 }, { id: "b_2" }];
    expect(decodeFileList(encodeFileList(list))).toEqual(list);
    expect(decodeFileList("a@0,../x,b@x,c@3")).toEqual([{ id: "a" }, { id: "b" }, { id: "c", version: 3 }]);
    expect(decodeFileList(undefined)).toEqual([]);
  });

  test("‹ › go one picture at a time and never round past the first or the last", () => {
    expect(pageStep(1, 1, 4)).toBe(2);
    expect(pageStep(1, -1, 4)).toBe(0);
    expect(pageStep(0, -1, 4)).toBeNull();
    expect(pageStep(3, 1, 4)).toBeNull();
    expect(pageStep(0, 1, 1)).toBeNull();
  });

  test("several pictures: 2 de 4 in the head, ‹ › on the sides (gone while zoomed) slide the pager as a swipe", () => {
    const viewer = src("features/files/ImageViewer.tsx");
    expect(viewer).toContain(
      'files.length > 1 ? t("mobile.files.place", { index: index + 1, count: files.length }) : ""',
    );
    expect(viewer).toContain("[place, author, savedWhen(savedAt(detail))].filter(Boolean)");
    expect(viewer).toContain(
      '<Round icon="left" label={t("mobile.files.previous")} plate={SCRIM} onPress={() => turn(prev)} />',
    );
    expect(viewer).toContain(
      '<Round icon="right" label={t("mobile.files.next")} plate={SCRIM} onPress={() => turn(next)} />',
    );
    expect(viewer).toContain("visible={chrome && !zoomed}");
    expect(viewer).toContain("pager.current?.scrollTo({ x: to * width, y: 0, animated: !reduced })");
    // The count took the dots' place: one place says where you are.
    expect(viewer).not.toContain("styles.dots");
  });

  test("‹ and › are one chevron mirrored, on a dark plate that reads on a light picture", () => {
    // `back` (7×14) is a size larger than `right` (6×12) and half a unit off center: `left` is `right` mirrored.
    expect(ICONS.left).toEqual([{ t: "path", d: "m15 6-6 6 6 6" }]);
    expect(ICONS.right).toEqual([{ t: "path", d: "m9 6 6 6-6 6" }]);
    // The close and ⋯ plates are light (they sit on the black above the picture); ‹ › sit on the picture.
    expect(src("features/files/ImageViewer.tsx")).toContain('const SCRIM = "rgba(0,0,0,0.45)";');
  });

  test("zoom keeps the point under the fingers still and stays inside the picture", () => {
    expect(zoomAround({ x: 0, y: 0 }, 1, 2, 50, -20)).toEqual({ x: -50, y: 20 });
    expect(zoomAround({ x: 0, y: 0 }, 1, 2, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(clampZoomTranslate(500, -500, 2, 400, 800)).toEqual({ x: 200, y: -400 });
    expect(clampZoomTranslate(30, 10, 1, 400, 800)).toEqual({ x: 0, y: 0 });
    // A wide banner drawn 400×100: zoomed 4× it is 1600×400, shorter than the screen, so it can't move up or down.
    expect(clampZoomTranslate(9999, 9999, 4, 400, 800, 400, 100)).toEqual({ x: 600, y: 0 });
    expect(containSize(3600, 900, 400, 800)).toEqual({ w: 400, h: 100 });
    expect(containSize(0, 0, 400, 800)).toEqual({ w: 400, h: 800 });
    expect(doubleTapZoom(400, 100, 400, 800)).toBe(MAX_ZOOM);
    expect(doubleTapZoom(400, 600, 400, 800)).toBe(2.5);
  });
});

describe("a document's head", () => {
  test("the bar keeps ×, Copiar texto and ⋯; the name and its line take a row of their own under it, never cut", () => {
    const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/DocumentViewer.tsx"), "utf8");
    const bar = viewer.slice(
      viewer.indexOf("<View style={[styles.top,"),
      viewer.indexOf("<View style={styles.heading}>"),
    );
    expect(bar).not.toContain("info?.name");
    expect(bar).not.toContain("styles.balance");
    const heading = viewer.slice(
      viewer.indexOf("<View style={styles.heading}>"),
      viewer.indexOf("<View style={styles.body}>"),
    );
    expect(heading).toContain("numberOfLines={3}");
    expect(heading).toContain("{info?.name");
    expect(heading).not.toContain("numberOfLines={1}");
  });

  test("a picture's head too: × and ⋯ on the first row, the name and its line on the row under them", () => {
    const viewer = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    const top = viewer.slice(viewer.indexOf("style={[styles.top,"), viewer.indexOf("</Chrome>"));
    expect(top.indexOf('icon="more"')).toBeLessThan(top.indexOf("{info?.name"));
    expect(top).toContain("numberOfLines={3}");
    expect(top).not.toContain("numberOfLines={1}");
    expect(viewer).toContain('title: { flexBasis: "100%", gap: 2 }');
  });

  test("among files a picture is only the picture, two to a row; a file takes the row, its name whole", () => {
    const tile = src("features/files/AttachmentTile.tsx");
    // The foot (icon, name, kind and size) only under a file; a picture's name and size are what VoiceOver says.
    expect(tile).toMatch(/\{picture \? null : \(\s*<View style=\{styles\.foot\}>/);
    expect(tile).toMatch(/accessibilityLabel=\{`\$\{name\}, \$\{meta\}`\}/);
    // Known to be a picture by its name before it loads, so it never sheds a foot once it does.
    expect(tile).toContain('const picture = info ? info.view === "image" : seen;');
    const foot = tile.slice(tile.indexOf("<View style={styles.foot}>"), tile.indexOf("function fileIconOf("));
    expect(foot).not.toContain("numberOfLines");
    expect(foot).toContain('<LineIcon name={icon} size={14} color={c.faint} variant="footnote" />');
    const files = src("features/files/MessageFiles.tsx");
    expect(files).toContain("width={picture ? halfWidth : blockWidth}");
    expect(files).toContain("...images.map((i) => ({ ...i, failed: false, picture: true }))");
  });

  test("the line under a file's name breaks between its facts, never inside one", () => {
    const files = readFileSync(join(import.meta.dir, "../../src/features/files/MessageFiles.tsx"), "utf8");
    expect(files.slice(files.indexOf("export function useFileLine("))).toMatch(
      /\]\s*\.map\(keepWhole\)\s*\.join\(" · "\)/,
    );
    const image = readFileSync(join(import.meta.dir, "../../src/features/files/ImageViewer.tsx"), "utf8");
    expect(image).toContain('[place, author, savedWhen(savedAt(detail))].filter(Boolean).map(keepWhole).join(" · ")');
  });

  test("a chart opened whole: × alone on the bar, its title on a row of its own under it, never cut", () => {
    const chart = readFileSync(join(import.meta.dir, "../../src/features/chat/ChartCard.tsx"), "utf8");
    const bar = chart.slice(chart.indexOf("<View style={styles.sheetTop}>"), chart.indexOf("{chart.spec.title}"));
    expect(bar.indexOf("</View>")).toBeLessThan(bar.indexOf("<Text"));
    expect(bar).not.toContain("numberOfLines");
    expect(chart).not.toContain("sheetSpacer");
  });

  test("a browser profile's sign-in screen keeps its name and line whole beside ×", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/browser/ProfileLoginScreen.tsx"), "utf8");
    const top = screen.slice(screen.indexOf("<View style={[styles.top,"), screen.indexOf("<ScrollView"));
    expect(top).not.toContain("numberOfLines");
  });
});
