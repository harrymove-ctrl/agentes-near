import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys, type StoragePlatform } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { createMockStorage } from "./fakes/storage";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState()) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
  await settle(5);
  return { api, r };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const section = () => screen().getByRole("region", { name: "Armazenamento" });
/** Text as read, no-break spaces as spaces. */
const text = (el: Element | null | undefined) => el?.textContent?.replaceAll("\u00a0", " ");
/** An option's lines under its title: its words, then what its files take where it is the one in use. */
const linesOf = (option: Element | null | undefined) =>
  [...(option?.closest("label")?.querySelectorAll(".ac-option__desc") ?? [])].map(text);
const GB = 1024 ** 3;
// Query timers don't run under the test DOM (TanStack sees no window at import): poll by hand.
type Rendered = Awaited<ReturnType<typeof go>>["r"];
const poll = async (r: Rendered, times: number) => {
  for (let i = 0; i < times; i++) {
    await act(() => r.services.queryClient.refetchQueries({ queryKey: keys.storageMigration(ORG_ID) }));
    await settle(2);
  }
};

const fillBucket = async (bucket: string) => {
  const s = within(section());
  await type(s.getByLabelText("Endpoint"), "https://s3.amazonaws.com");
  await type(s.getByLabelText("Região"), "sa-east-1");
  await type(s.getByLabelText("Bucket"), bucket);
  await type(s.getByLabelText("Access key"), "AKIAEXAMPLE1234");
  await type(s.getByLabelText("Secret"), "secret-value-9876");
};
const testConnection = async () => {
  await click(within(section()).getByRole("button", { name: "Testar conexão" }));
  await settle(4);
};
const activate = () => within(section()).getByRole("button", { name: "Ativar" });

describe("Configurações → Armazenamento", () => {
  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Armazenamento" })).toBeNull();
  });

  test("on a server people run, files stay on this server: its disk, the folder, its database or its bucket", async () => {
    await go();
    const s = section();
    const server = within(s).getByRole("radio", { name: /Este servidor/ });
    expect(server.getAttribute("aria-checked")).toBe("true");
    // The page's title names the card, so the choices come first, and the radio alone says which is in use.
    expect(s.querySelector("h2, h3")).toBeNull();
    expect(s.textContent?.indexOf("Este servidor")).toBe(0);
    expect(text(server.closest("label"))).toBe("Este servidorOs arquivos ficam no disco dele.Nenhum arquivo");
    // Our storage is the Cloud's: never said where the server is someone's own.
    expect(s.textContent).not.toMatch(/nosso armazenamento|Armazenamento do agentes/);
    // No native Google Drive or OneDrive is coming (they connect through Conectores): never promised here.
    expect(
      within(s)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["agentes", "s3"]);
    expect(s.textContent).not.toMatch(/Google Drive|OneDrive|Em breve/);
    expect(within(s).queryByLabelText("Endpoint")).toBeNull();

    const line = async (platform: StoragePlatform) => {
      cleanup();
      await go(seedState({ storagePlatform: platform }));
      return within(section())
        .getByRole("radio", { name: /Este servidor/ })
        .closest("label") as HTMLElement;
    };
    expect((await line({ kind: "database", folder: null })).textContent).toContain(
      "Os arquivos ficam no banco de dados dele.",
    );
    expect((await line({ kind: "bucket", folder: null })).textContent).toContain(
      "Os arquivos ficam no bucket configurado para ele.",
    );
    const folder = await line({ kind: "disk", folder: "/Users/walter/.agentes/files" });
    expect(folder.textContent).toContain("Os arquivos ficam em /Users/walter/.agentes/files.");
    expect(folder.querySelector("code")?.textContent).toBe("/Users/walter/.agentes/files");
    // Show the folder is the desktop app's, on its own server: never in a browser.
    expect(within(section()).queryByRole("button", { name: "Mostrar a pasta" })).toBeNull();
  });

  test("on the Cloud, agentes storage keeps its words", async () => {
    const api = createFakeApi(seedState());
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    const ours = within(section()).getByRole("radio", { name: /Armazenamento do agentes/ });
    expect(ours.getAttribute("aria-checked")).toBe("true");
    expect(text(ours.closest("label"))).toBe(
      "Armazenamento do agentes.chatSeus arquivos ficam no nosso armazenamento, separados por workspace.Nenhum arquivo",
    );
    expect(section().textContent).not.toContain("Este servidor");
  });

  test("the option in use says what its files take: on this server's disk with what is free, in its database or bucket, on the Cloud", async () => {
    const lines = async (state: Partial<FakeState>, options: { cloud?: boolean; en?: boolean } = {}) => {
      cleanup();
      const api = createFakeApi(seedState(state));
      if (options.cloud) fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
      const { services } = await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
      await settle(5);
      if (options.en) {
        await act(async () => {
          await services.i18n.changeLanguage("en");
        });
        await settle(3);
      }
      return linesOf(document.querySelector('label.ac-option[data-state="checked"]'));
    };
    const disk = { platformBytes: 2.4 * GB, ownBucketBytes: 0, disk: { sizeBytes: 256 * GB, freeBytes: 38 * GB } };
    expect(await lines({ storageUsage: disk })).toEqual([
      "Os arquivos ficam no disco dele.",
      "2,4 GB de arquivos · 38 GB livres no disco",
    ]);
    expect(await lines({ storageUsage: disk }, { en: true })).toEqual([
      "Files stay on its disk.",
      "2.4 GB of files · 38 GB free on disk",
    ]);
    // The desktop app's folder: nothing there yet, on a big disk.
    const folder: StoragePlatform = { kind: "disk", folder: "/Users/walter/.agentes/files" };
    const empty = { platformBytes: 0, ownBucketBytes: 0, disk: { sizeBytes: 2048 * GB, freeBytes: 1.5 * 1024 * GB } };
    expect((await lines({ storagePlatform: folder, storageUsage: empty }))[1]).toBe(
      "Nenhum arquivo · 1,5 TB livres no disco",
    );
    // A database or a bucket says what it holds, with no disk of the server's to tell.
    const held = (platformBytes: number) => ({ platformBytes, ownBucketBytes: 0, disk: null });
    expect(
      await lines({ storagePlatform: { kind: "database", folder: null }, storageUsage: held(300 * 1024 ** 2) }),
    ).toEqual(["Os arquivos ficam no banco de dados dele.", "300 MB de arquivos"]);
    expect(await lines({ storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(12 * GB) })).toEqual([
      "Os arquivos ficam no bucket configurado para ele.",
      "12 GB de arquivos",
    ]);
    expect(
      await lines({ storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(3.2 * GB) }, { cloud: true }),
    ).toEqual(["Seus arquivos ficam no nosso armazenamento, separados por workspace.", "3,2 GB de arquivos"]);
    expect(
      await lines(
        { storagePlatform: { kind: "bucket", folder: null }, storageUsage: held(3.2 * GB) },
        { cloud: true, en: true },
      ),
    ).toEqual(["Your files stay in our storage, kept apart per workspace.", "3.2 GB of files"]);
    // The Cloud keeps them on its own disk too, which every workspace there shares: its server sends no disk, so the
    // line is the workspace's files alone.
    const cloudDisk = { storagePlatform: { kind: "disk", folder: null } as StoragePlatform, storageUsage: held(0) };
    expect((await lines(cloudDisk, { cloud: true }))[1]).toBe("Nenhum arquivo");
    expect((await lines(cloudDisk, { cloud: true, en: true }))[1]).toBe("No files");
  });

  test("under a storage limit the meter says what the files take, and the option in use doesn't say it again", async () => {
    const api = createFakeApi(
      seedState({
        storagePlatform: { kind: "bucket", folder: null },
        storageUsage: { platformBytes: 3.2 * GB, ownBucketBytes: 0, disk: null },
        limits: {
          members: { used: 2, limit: null },
          storage: { usedBytes: 3.2 * GB, limitBytes: 50 * GB, ownStorage: false },
          uploads: { usedBytes24h: 0, limitBytesPerDay: null },
        },
      }),
    );
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
    await settle(5);
    expect(text(section())).toContain("Vocês usaram 3,2 GB de 50 GB.");
    expect(linesOf(document.querySelector('label.ac-option[data-state="checked"]'))).toEqual([
      "Seus arquivos ficam no nosso armazenamento, separados por workspace.",
    ]);
  });

  test("on its own bucket, that option says what the bucket holds; picked and not saved, the line stays put", async () => {
    await go(
      seedState({
        storageUsage: {
          platformBytes: 2 * GB,
          ownBucketBytes: 1.2 * GB,
          disk: { sizeBytes: 100 * GB, freeBytes: 40 * GB },
        },
      }),
    );
    const server = () => within(section()).getByRole("radio", { name: /Este servidor/ });
    const bucket = () => within(section()).getByRole("radio", { name: /Seu próprio bucket/ });
    await click(bucket());
    expect(linesOf(server())).toEqual(["Os arquivos ficam no disco dele.", "2 GB de arquivos · 40 GB livres no disco"]);
    expect(linesOf(bucket())).toEqual(["S3, R2, MinIO e outros compatíveis com S3."]);
    await fillBucket("acme-arquivos");
    await testConnection();
    await click(activate());
    await settle(4);
    expect(linesOf(bucket())).toEqual(["S3, R2, MinIO e outros compatíveis com S3.", "1,2 GB de arquivos"]);
    expect(linesOf(server())).toEqual(["Os arquivos ficam no disco dele."]);
  });

  test("Show the folder: in the desktop app on its own server, once the app opens it", async () => {
    const win = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    const asked: Record<string, unknown>[] = [];
    const app = (flags: Record<string, unknown>, local: boolean) => {
      win.__agentesDesktop = { version: "0.6.0", ...flags };
      win.__TAURI_INTERNALS__ = {
        invoke: async (_cmd: string, args: { request: Record<string, unknown> }) => {
          asked.push(args.request);
          return args.request.kind === "status" ? { orgs: [], local } : {};
        },
      };
    };
    const show = async (platform: StoragePlatform) => {
      cleanup();
      await go(seedState({ storagePlatform: platform }));
      return within(section()).queryByRole("button", { name: "Mostrar a pasta" });
    };
    const folder: StoragePlatform = { kind: "disk", folder: "/Users/walter/.agentes/files" };
    try {
      // An app from before it could: nothing.
      app({}, true);
      expect(await show(folder)).toBeNull();
      // Another server's page in the app: nothing.
      app({ files: true }, false);
      expect(await show(folder)).toBeNull();
      // Its own server, keeping files in a database: no folder to show.
      app({ files: true }, true);
      expect(await show({ kind: "database", folder: null })).toBeNull();
      const button = await show(folder);
      // Under the options: an option is a label, which can't hold a button.
      expect(button?.closest("label")).toBeNull();
      expect(button?.parentElement?.previousElementSibling?.getAttribute("role")).toBe("radiogroup");
      await click(button as HTMLElement);
      expect(asked.at(-1)).toEqual({ kind: "files" });
    } finally {
      delete win.__agentesDesktop;
      delete win.__TAURI_INTERNALS__;
    }
  });

  test("a failing step shows its error; Ativar waits for a passing test of the same settings", async () => {
    const { api } = await go();
    await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
    expect(activate().hasAttribute("disabled")).toBe(true);
    // Until the bucket is saved, the server's option says it's still the one in use, on its title's line: the
    // description under them keeps the card's whole width.
    const inUse = () =>
      [...section().querySelectorAll(".ac-option__head")].filter((h) => h.textContent?.endsWith("Em uso"));
    expect(inUse().map((h) => h.textContent)).toEqual(["Este servidorEm uso"]);
    expect(inUse()[0]?.nextElementSibling?.textContent).toBe("Os arquivos ficam no disco dele.");

    // Empty form: the test does not run, fields explain why.
    await testConnection();
    expect(section().textContent).toContain("Preencha este campo.");
    expect(section().textContent).toContain("Informe a access key e o secret.");

    await fillBucket("acme-negado");
    await testConnection();
    const steps = within(section()).getByRole("region", { name: "Resultado do teste" });
    const write = steps.querySelector('[data-step="write"]');
    expect(write?.textContent).toContain("Escrever");
    expect(write?.textContent).toContain("Falhou");
    expect(write?.textContent).toContain("AccessDenied: a chave não pode escrever neste bucket.");
    expect(steps.querySelector('[data-step="read"]')?.textContent).toContain("Não testado");
    expect(steps.textContent).toContain("A conexão não passou no teste.");
    expect(activate().hasAttribute("disabled")).toBe(true);

    await type(within(section()).getByLabelText("Bucket"), "acme-arquivos");
    expect(section().textContent).toContain("As configurações mudaram. Teste de novo antes de ativar.");
    await testConnection();
    const ok = within(section()).getByRole("region", { name: "Resultado do teste" });
    for (const step of ["write", "read", "list", "delete"]) {
      expect(ok.querySelector(`[data-step="${step}"]`)?.textContent).toContain("Funcionou");
    }
    expect(activate().hasAttribute("disabled")).toBe(false);

    // Changing anything asks for a new test.
    await click(within(section()).getByLabelText("Estilo de caminho"));
    expect(activate().hasAttribute("disabled")).toBe(true);
    await click(within(section()).getByLabelText("Estilo de caminho"));
    expect(activate().hasAttribute("disabled")).toBe(false);

    await click(activate());
    await settle(4);
    const s = section();
    expect(inUse()).toEqual([]);
    expect(s.textContent).toContain("Arquivos antigos continuam onde estão. Novos arquivos vão para o seu bucket.");
    expect(s.textContent).toContain("Usando acme-arquivos em https://s3.amazonaws.com.");
    // Keys are masked: only hints, inputs empty.
    expect(s.textContent).toContain("Salva, termina em 1234. Deixe em branco para manter.");
    expect(s.textContent).toContain("Salva, termina em 9876.");
    expect((within(s).getByLabelText("Secret") as HTMLInputElement).value).toBe("");
    expect(within(s).getByLabelText("Secret").getAttribute("type")).toBe("password");
    expect(s.textContent).not.toContain("secret-value-9876");
    const config = await api.storage.get(ORG_ID);
    expect(config.kind).toBe("s3");
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  test("copy existing files shows progress, stops, resumes and finishes", async () => {
    const { r } = await go(
      seedState({
        storageUsage: { platformBytes: 2 * GB, ownBucketBytes: 0, disk: { sizeBytes: 100 * GB, freeBytes: 40 * GB } },
      }),
    );
    await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
    await fillBucket("acme-instavel");
    await testConnection();
    await click(activate());
    await settle(4);
    const bucket = () => within(section()).getByRole("radio", { name: /Seu próprio bucket/ });
    expect(linesOf(bucket())).toEqual(["S3, R2, MinIO e outros compatíveis com S3.", "Nenhum arquivo"]);
    await click(within(section()).getByRole("button", { name: "Copiar arquivos existentes" }));
    await settle(2);
    expect(within(section()).getByRole("meter", { name: "Progresso da cópia" })).toBeTruthy();
    await poll(r, 1);
    expect(section().textContent).toContain("Copiando arquivos: 40 de 120");
    await poll(r, 1);
    expect(section().textContent).toContain("A cópia parou em 80 de 120.");
    expect(section().textContent).toContain("A conexão com o bucket caiu.");
    await click(within(section()).getByRole("button", { name: "Retomar cópia" }));
    await settle(2);
    await poll(r, 2);
    expect(section().textContent).toContain("Cópia concluída: 120 arquivos no seu bucket.");
    expect(within(section()).getByRole("meter").getAttribute("aria-valuenow")).toBe("120");
    // The bucket's card says what the copy took there, without reopening the page.
    await settle(3);
    expect(linesOf(bucket())).toEqual(["S3, R2, MinIO e outros compatíveis com S3.", "2 GB de arquivos"]);
  });

  test("switch back to this server after confirming, or to agentes storage on the Cloud", async () => {
    const back = async (cloud: boolean) => {
      cleanup();
      const api = createFakeApi(seedState());
      if (cloud) fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
      await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
      await settle(5);
      await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
      await fillBucket("acme-arquivos");
      await testConnection();
      await click(activate());
      await settle(4);
      return api;
    };
    const api = await back(false);
    expect(section().textContent).toContain("Copia para o seu bucket os arquivos que este servidor ainda guarda.");
    await click(within(section()).getByRole("button", { name: "Voltar para este servidor" }));
    const dialog = screen().getByRole("dialog", { name: "Voltar para este servidor?" });
    expect(dialog.textContent).toContain(
      "Novos arquivos voltam para este servidor. O que já está no seu bucket continua lá.",
    );
    await click(within(dialog).getByRole("button", { name: "Voltar para este servidor" }));
    await settle(4);
    expect((await api.storage.get(ORG_ID)).kind).toBe("agentes");
    expect(section().textContent).not.toContain("Novos arquivos vão para o seu bucket.");
    expect(document.body.textContent).toContain("Armazenamento trocado para este servidor.");

    await back(true);
    expect(section().textContent).toContain(
      "Copia para o seu bucket os arquivos que o armazenamento do agentes.chat ainda guarda.",
    );
    await click(within(section()).getByRole("button", { name: "Voltar para o armazenamento do agentes.chat" }));
    const cloud = screen().getByRole("dialog", { name: "Voltar para o armazenamento do agentes.chat?" });
    expect(cloud.textContent).toContain("Novos arquivos voltam para o armazenamento do agentes.chat.");
  });
});

describe("storage mock", () => {
  const s3 = { endpoint: "https://r2.example", region: "auto", bucket: "b", prefix: null, pathStyle: true };
  test("activating needs a passing test of the same settings", async () => {
    const m = createMockStorage();
    await expect(m.save("o", { kind: "s3", s3 })).rejects.toThrow();
    expect((await m.test("o", { ...s3, bucket: "lista" })).steps.map((x) => x.ok)).toEqual([true, true, false, false]);
    await m.test("o", s3);
    await expect(m.save("o", { kind: "s3", s3: { ...s3, region: "x" } })).rejects.toThrow();
    expect(
      (await m.save("o", { kind: "s3", s3: { ...s3, accessKeyId: "AK12", secretAccessKey: "SSSS" } })).s3,
    ).toMatchObject({ accessKeyIdHint: "AK12", secretHint: "SSSS" });
  });
});
