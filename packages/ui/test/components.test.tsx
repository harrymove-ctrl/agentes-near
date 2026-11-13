import { describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  ApprovalCard,
  Avatar,
  AvatarStack,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Chip,
  Composer,
  EventPill,
  FilterChip,
  Icon,
  type IconName,
  iconNames,
  initialsOf,
  ListRow,
  Logo,
  Menu,
  MenuCheckboxItem,
  MenuFace,
  MenuItem,
  MenuRadioGroup,
  MenuReactions,
  Message,
  MessageText,
  Meter,
  RunMark,
  Steps,
  Textarea,
} from "../src";

const body = () => within(document.body);

describe("Button", () => {
  test("variants map to the design classes; default type is button", () => {
    render(
      <>
        <Button variant="primary">Aprovar merge</Button>
        <Button variant="agent">Pedir à Ada</Button>
        <Button variant="ghost" size="sm" iconOnly icon="close" aria-label="Fechar" />
      </>,
    );
    const primary = body().getByRole("button", { name: "Aprovar merge" });
    expect(primary.className).toBe("ac-btn ac-btn--primary");
    expect(primary.getAttribute("type")).toBe("button");
    const agent = body().getByRole("button", { name: "Pedir à Ada" });
    expect(agent.className).toContain("ac-btn--agent");
    // The agent button carries the agent icon.
    expect(agent.querySelector("svg.ac-icon")).not.toBeNull();
    const close = body().getByRole("button", { name: "Fechar" });
    expect(close.className).toBe("ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon");
    expect(close.textContent).toBe("");
  });

  test("an icon-only button with no icon of its own shows its child as the glyph", () => {
    render(
      <>
        <Button variant="ghost" size="sm" iconOnly aria-label="Parar">
          <span className="glyph" />
        </Button>
        <Button variant="ghost" size="sm" iconOnly icon="close" aria-label="Fechar">
          <span className="glyph" />
        </Button>
      </>,
    );
    const stop = body().getByRole("button", { name: "Parar" });
    expect(stop.className).toContain("ac-btn--icon");
    expect(stop.querySelector(".glyph")).not.toBeNull();
    // With an icon, the icon alone.
    const close = body().getByRole("button", { name: "Fechar" });
    expect(close.querySelector(".glyph")).toBeNull();
    expect(close.querySelector("svg.ac-icon")).not.toBeNull();
  });

  test("asChild renders a link with button styles", () => {
    render(
      <Button asChild variant="primary">
        <a href="/x">Entrar</a>
      </Button>,
    );
    const link = body().getByRole("link", { name: "Entrar" });
    expect(link.className).toContain("ac-btn--primary");
  });
});

describe("Avatar", () => {
  test("people and agents share the framed tile; running ring only for agents", () => {
    const { container } = render(
      <>
        <Avatar name="Marina" />
        <Avatar kind="agent" name="Atlas" initials="At" running />
        <Avatar name="João" running />
      </>,
    );
    const [person, agent, notAgent] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(person?.className).toBe("ac-avatar ac-avatar--framed");
    expect(agent?.className).toContain("ac-avatar--framed");
    expect(person?.textContent).toBe("M");
    expect(agent?.className).toContain("ac-avatar--agent");
    expect(agent?.className).toContain("ac-avatar--running");
    // The agent symbol is drawn by the engine (no initials); running = thinking.
    expect(agent?.textContent).toBe("");
    expect(agent?.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(agent?.getAttribute("data-state")).toBe("thinking");
    expect(notAgent?.className).not.toContain("ac-avatar--running");
    expect(person?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the 18px receipt and the 112px hero stand unframed unless asked", () => {
    const { container } = render(
      <>
        <Avatar kind="agent" name="Ada" size="xs" />
        <Avatar kind="agent" name="Ada" size="xl" />
        <Avatar kind="agent" name="Ada" size="xl" framed />
        <Avatar name="Marina" size="sm" framed={false} />
      </>,
    );
    const [xs, xl, xlFramed, person] = Array.from(container.querySelectorAll(".ac-avatar"));
    expect(xs?.className).not.toContain("ac-avatar--framed");
    expect(xl?.className).not.toContain("ac-avatar--framed");
    expect(xlFramed?.className).toContain("ac-avatar--framed");
    expect(person?.className).not.toContain("ac-avatar--framed");
  });

  test("labelled avatars expose the name", () => {
    render(<Avatar kind="agent" name="Ada" labelled />);
    expect(body().getByRole("img", { name: "Ada" })).toBeTruthy();
  });

  test("initials", () => {
    expect(initialsOf("Ada")).toBe("A");
    expect(initialsOf("Marina Souza Lima")).toBe("ML");
    expect(initialsOf("佐藤 花子")).toBe("佐");
    expect(initialsOf("김 민수")).toBe("김");
    expect(initialsOf("  ")).toBe("?");
    // An emoji before the name gives way to the words; an emoji alone stays whole, never half a character.
    expect(initialsOf("🌴 Ana Souza")).toBe("AS");
    expect(initialsOf("🦊")).toBe("🦊");
    expect(initialsOf("Ólafur Darri Ólafsson")).toBe("ÓÓ");
    // What tells relatives apart is no surname: "CM", never "CI"; a name of two words keeps both.
    expect(initialsOf("Christopher Alexander Montgomery III")).toBe("CM");
    expect(initialsOf("João Pereira Filho")).toBe("JP");
    expect(initialsOf("Martin Luther King Jr.")).toBe("MK");
    expect(initialsOf("Pedro Neto")).toBe("PN");
  });
});

describe("Chip", () => {
  test("a state renders its icon with the word", () => {
    const { container } = render(
      <Chip icon="waiting" tone="waiting">
        Aguardando você
      </Chip>,
    );
    const chip = container.querySelector(".ac-chip");
    expect(chip?.className).toBe("ac-chip ac-chip--waiting");
    expect(chip?.querySelector("svg.ac-icon")).not.toBeNull();
    expect(chip?.textContent).toBe("Aguardando você");
  });

  test("a value goes without an icon, same shape", () => {
    const { container } = render(<Chip>Issue: ACME-177</Chip>);
    const chip = container.querySelector(".ac-chip");
    expect(chip?.querySelector("svg")).toBeNull();
    expect(chip?.textContent).toBe("Issue: ACME-177");
  });

  test("22 high with 12px words; an icon's side pads 6, its ink 2 into its box, so the ink reads 8 on both sides", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-chip")).toContain("height: 22px;");
    expect(rule(".ac-chip")).toContain("padding: 0 var(--space-2);");
    expect(rule(".ac-chip")).toContain("font-size: 12px;");
    expect(rule(".ac-chip:has(> .ac-icon:first-child)")).toContain("padding-inline-start: 6px;");
  });
});

describe("ApprovalCard", () => {
  test("waiting card: neutral card, attention chip, title, detail and actions", () => {
    const { container } = render(
      <ApprovalCard
        status="waiting"
        aria-label="Pedido de aprovação"
        who={
          <>
            <b>Ada</b> pede aprovação
          </>
        }
        statusLabel="Aguardando você"
        title="Fazer merge do PR #42 em main"
        detail="github.merge · agentes-chat/app · PR 42"
        actions={<Button variant="primary">Aprovar merge</Button>}
      />,
    );
    const card = body().getByRole("group", { name: "Pedido de aprovação" });
    expect(card.className).toBe("ac-approval");
    expect(container.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando você");
    expect(card.textContent).toContain("Fazer merge do PR #42 em main");
    expect(within(card).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
  });

  test("the detail sits in a well in both themes, never in the page's tone (the light card's own white)", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-approval")).toContain("background: var(--surface-raised);");
    expect(rule(".ac-approval__detail")).toContain("background: var(--surface-sunken);");
  });

  test("decided card shrinks and uses a done/neutral chip", () => {
    const { container } = render(
      <>
        <ApprovalCard
          compact
          status="approved"
          who="Ada · merge do PR #42 em main"
          statusLabel="Aprovado por você · agora"
        />
        <ApprovalCard
          compact
          status="refused"
          who="Ada · merge do PR #42 em main"
          statusLabel="Recusado por você · agora"
        />
      </>,
    );
    const cards = container.querySelectorAll(".ac-approval--done");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector(".ac-chip")?.className).toBe("ac-chip ac-chip--done");
    expect(cards[1]?.querySelector(".ac-chip")?.className).toBe("ac-chip");
    expect(container.querySelector(".ac-approval__actions")).toBeNull();
  });
});

describe("Card", () => {
  test("head: icon key, h2 with id, quiet line and action; foot: help text in the well", () => {
    const { container } = render(
      <Card aria-labelledby="c-title">
        <CardHeader
          id="c-title"
          icon="document"
          title="O que o Theo faz"
          subtitle="Instruções"
          action={<Button>Editar</Button>}
        />
        <CardFooter>O contexto entra antes</CardFooter>
      </Card>,
    );
    const card = container.querySelector("section.ac-card");
    expect(card?.getAttribute("aria-labelledby")).toBe("c-title");
    expect(card?.querySelector("h2#c-title")?.textContent).toBe("O que o Theo faz");
    expect(card?.querySelector(".ac-card__key svg")).not.toBeNull();
    expect(card?.querySelector(".ac-card__sub")?.textContent).toBe("Instruções");
    expect(card?.querySelector(".ac-card__action button")?.textContent).toBe("Editar");
    expect(card?.querySelector(".ac-card__foot")?.textContent).toBe("O contexto entra antes");
  });

  test("no icon, subtitle or action: only the title", () => {
    const { container } = render(<CardHeader title="Só título" />);
    expect(container.querySelector(".ac-card__key")).toBeNull();
    expect(container.querySelector(".ac-card__sub")).toBeNull();
    expect(container.querySelector(".ac-card__action")).toBeNull();
  });

  test("the key and the foot's icon lead their first line; without an icon nothing is moved", async () => {
    const { container } = render(
      <>
        <CardHeader
          icon="wallet"
          title="Limite de gastos por agente"
          subtitle="Por mês"
          action={<Button>US$</Button>}
        />
        <CardHeader title="Só título" />
        <CardFooter>Ninguém gasta além disso</CardFooter>
        <CardFooter icon={null}>Sem ícone</CardFooter>
      </>,
    );
    // The key leads the title's own row (the action stays out of it), so it keeps the title's first line however the
    // title wraps beside a taller action. The head is an action line: an action that doesn't fit goes under the title.
    const [withKey, plain] = [...container.querySelectorAll(".ac-card__lead")];
    expect(withKey?.className).toBe("ac-card__lead ac-iconline");
    expect(withKey?.firstElementChild?.className).toBe("ac-card__key");
    expect(withKey?.parentElement?.className).toBe("ac-card__head ac-actline");
    expect(withKey?.parentElement?.lastElementChild?.className).toBe("ac-card__action");
    expect(plain?.className).toBe("ac-card__lead");
    const [foot, bare] = [...container.querySelectorAll(".ac-card__foot")];
    expect(foot?.className).toBe("ac-card__foot ac-iconline");
    expect(foot?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(bare?.className).toBe("ac-card__foot");
    // The key follows the title's 20px line, not the title and its quiet line; the action stays in the middle.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-card__head")).toContain("line-height: 20px");
    expect(rule(".ac-card__head")).toContain("align-items: flex-start");
    expect(rule(".ac-card__head:not(:has(.ac-card__sub))")).toContain("align-items: center");
    expect(rule(".ac-card__action")).toContain("align-self: center");
    // The foot's words take its line, so an action among them reaches its end.
    expect(rule(".ac-card__foot > span")).toContain("flex: 1;");
    for (const row of [".ac-card__foot", ".ac-setnote", ".ac-alert"]) {
      expect(rule(row)).not.toContain("display:");
      expect(rule(row)).not.toContain("align-items:");
    }
    // A note is small text on its own 13/18 line, as a panel's other small lines: never the 22px line of the dialog
    // or the page it sits in, which spreads a note's lines apart.
    expect(rule(".ac-setnote")).toContain("font-size: 13px");
    expect(rule(".ac-setnote")).toContain("line-height: 18px");
  });
});

test("an avatar's initials sit in the middle of its tile at any size: it brings its own line height", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".ac-avatar")).toContain("place-items: center;");
  expect(rule(".ac-avatar")).toContain("line-height: 1;");
});

test("an avatar's initials are a box of their own trimmed to their capitals, so the tile centres the letters", async () => {
  const { container } = render(
    <>
      <Avatar name="João Silva" />
      <Avatar name="Ana" imageUrl="data:image/png;base64,iVBORw0KGgo=" />
    </>,
  );
  const [initials, photo] = [...container.querySelectorAll(".ac-avatar")];
  expect(initials?.querySelector(":scope > .ac-avatar__initials")?.textContent).toBe("JS");
  expect(photo?.querySelector(".ac-avatar__initials")).toBeNull();
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".ac-avatar__initials")).toContain("text-box: trim-both cap alphabetic;");
  // Where text-box is unknown, the line's own offset: the capitals' middle sits --cap-mid above the line's.
  expect(css).toMatch(
    /@supports not \(text-box: trim-both cap alphabetic\) \{\s*\.ac-avatar__initials \{\s*translate: 0 var\(--cap-mid\);/,
  );
});

test("an event pill's mark sits on its sentence's first line and its time on that line's baseline, wrapped or not", async () => {
  const { container } = render(
    <EventPill mark={<Icon name="pause" size={14} />} time="14:16">
      Você parou a Ada
    </EventPill>,
  );
  const main = container.querySelector(".ac-eventpill__main");
  expect([...(main?.children ?? [])].map((c) => c.className)).toEqual([
    "ac-eventpill__mark",
    "ac-eventpill__text",
    "ac-eventpill__time",
  ]);
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  expect(rule(".ac-eventpill__main")).toContain("align-items: flex-start;");
  expect(rule(".ac-eventpill__mark")).toContain("translate: 0 calc(9px - var(--cap-mid) - 50%);");
  expect(css).toContain(
    "@supports (top: 1lh) {\n  .ac-eventpill__mark {\n    translate: 0 calc(0.5lh - var(--cap-mid) - 50%);",
  );
  for (const words of [".ac-eventpill__text", ".ac-eventpill__time"])
    expect(rule(words)).toContain("align-self: baseline;");
});

test("a glyph inside words sits on their capitals (Icon inline), with its size for the formula", async () => {
  const { container } = render(
    <p>
      Ada <Icon name="pause" size={14} inline /> <Icon name="pause" size={14} />
    </p>,
  );
  const [inline, plain] = [...container.querySelectorAll("svg")];
  expect(inline?.getAttribute("class")).toBe("ac-icon ac-icon--inline");
  expect((inline as SVGElement | undefined)?.style.getPropertyValue("--glyph")).toBe("14px");
  expect(plain?.getAttribute("class")).toBe("ac-icon");
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  // The inline face's formula (`.ac-who > .ac-avatar`): its middle where the capitals' middle is, above the baseline.
  expect(rule(".ac-icon--inline")).toContain(
    "vertical-align: calc(var(--cap-top) - var(--cap-mid) - var(--glyph, 20px) / 2);",
  );
});

describe("single-line controls", () => {
  test("buttons, inputs and selects centre their text in the box: the line is the text's own", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    for (const selector of [
      ".ac-btn",
      ".ac-input",
      ".ac-input-affix",
      ".ac-select__trigger",
      ".ac-palette__q input",
      ".ac-seg__item",
      ".ac-filtertoggle",
      ".ac-composer__pill,\n.ac-composer__agent",
      ".ac-recur__day",
      ".ac-react",
    ]) {
      const body = rule(selector);
      expect(body).toContain("line-height: normal");
      // After `font: inherit`, which would reset it.
      if (body.includes("font: inherit")) expect(body.indexOf("line-height")).toBeGreaterThan(body.indexOf("font:"));
    }
    // Text that wraps keeps its line.
    expect(rule("textarea.ac-input")).toContain("line-height: 22px");
  });
});

describe("links", () => {
  test("any link reads as ours, never the browser's blue; .ac-link is underlined in the house hairline", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    // Zero specificity: a class that styles its link still wins.
    expect(rule(":where(a)")).toContain("color: inherit");
    expect(rule(":where(a)")).toContain("text-decoration-color: var(--line2)");
    expect(rule(":where(a)")).toContain("text-underline-offset: 3px");
    expect(rule(":where(a:hover)")).toContain("text-decoration-color: currentColor");
    expect(rule(".ac-link")).toContain("text-decoration: underline");
    expect(rule(".ac-link")).toContain("text-decoration-color: var(--line2)");
    expect(rule(".ac-link")).toContain("text-underline-offset: 3px");
    expect(rule(".ac-link:hover")).toContain("text-decoration-color: currentColor");
    expect(rule(".ac-link--muted:hover")).toContain("color: var(--ink)");
    // A link that is a button has no box of its own and the sentence's whole type (the browser's button font would
    // drop the page's size adjustment and figures). It comes first, so `.ac-link`'s weight and size classes win.
    const button = rule(":where(button).ac-link");
    expect(button).toContain("border: 0");
    expect(button).toContain("background: none");
    expect(button).toContain("font: inherit");
    expect(css.indexOf("\n:where(button).ac-link {")).toBeGreaterThan(-1);
    expect(css.indexOf("\n:where(button).ac-link {")).toBeLessThan(css.indexOf("\n.ac-link {"));
    expect(css.indexOf("\n:where(button).ac-link {")).toBeLessThan(css.indexOf("\n.ac-link--muted {"));
  });
});

describe("Composer", () => {
  function Harness({ onSend }: { onSend: (t: string) => void }) {
    const [v, setV] = useState("");
    return (
      <Composer
        value={v}
        onChange={setV}
        onSend={(t) => {
          onSend(t);
          setV("");
        }}
        label="Mensagem para #eng"
        sendLabel="Enviar"
        attachLabel="Anexar arquivo"
      />
    );
  }

  test("Enter sends the trimmed text, Shift+Enter does not, empty text never sends", async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    const box = body().getByRole("textbox", { name: "Mensagem para #eng" });
    const send = body().getByRole("button", { name: "Enviar" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent).toEqual([]);
    await act(async () => fireEvent.change(box, { target: { value: "  @Ada olha o login  " } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter", shiftKey: true }));
    expect(sent).toEqual([]);
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent).toEqual(["@Ada olha o login"]);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  test("the send button sends", async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    await act(async () => fireEvent.change(body().getByRole("textbox"), { target: { value: "oi" } }));
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Enviar" })));
    expect(sent).toEqual(["oi"]);
  });
});

describe("boxes as tall as their text", () => {
  /** happy-dom lays nothing out: a box's text is 22 px a line under 20 px of padding, inside a 2 px border. */
  const measured = async (run: () => Promise<void>) => {
    const proto = HTMLTextAreaElement.prototype;
    const lines = (el: HTMLTextAreaElement) => el.value.split("\n").length;
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return 20 + 22 * lines(this);
      },
    });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 102 });
    try {
      await run();
    } finally {
      for (const key of ["scrollHeight", "clientHeight", "offsetHeight"]) Reflect.deleteProperty(proto, key);
    }
  };
  const type = (box: HTMLElement, value: string) => act(async () => fireEvent.change(box, { target: { value } }));

  test("Textarea autoGrow grows with its text, border included, and shrinks back; without it, its height is left alone", () =>
    measured(async () => {
      function Box({ grow }: { grow: boolean }) {
        const [value, setValue] = useState("uma linha");
        return (
          <Textarea
            autoGrow={grow}
            aria-label={grow ? "Cresce" : "Fixa"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        );
      }
      render(
        <>
          <Box grow />
          <Box grow={false} />
        </>,
      );
      const box = body().getByRole("textbox", { name: "Cresce" }) as HTMLTextAreaElement;
      expect(box.style.height).toBe("44px");
      await type(box, "um\ndois\ntrês");
      expect(box.style.height).toBe("88px");
      await type(box, "um");
      expect(box.style.height).toBe("44px");
      expect((body().getByRole("textbox", { name: "Fixa" }) as HTMLTextAreaElement).style.height).toBe("");
    }));

  test("the composer grows the same way", () =>
    measured(async () => {
      function Chat() {
        const [value, setValue] = useState("");
        return (
          <Composer
            value={value}
            onChange={setValue}
            onSend={() => {}}
            label="Mensagem"
            sendLabel="Enviar"
            attachLabel="Anexar"
          />
        );
      }
      render(<Chat />);
      const box = body().getByRole("textbox", { name: "Mensagem" });
      expect(box.style.height).toBe("44px");
      await type(box, "um\ndois");
      expect(box.style.height).toBe("66px");
    }));
});

describe("Message", () => {
  test("streaming adds the cursor class and aria-busy; grouped hides the header visually", () => {
    const { container } = render(
      <>
        <Message
          avatar={<Avatar kind="agent" name="Atlas" />}
          author="Atlas"
          time="agora"
          meta="escrevendo…"
          agent
          streaming
        >
          <MessageText>Os 401 no Sentry caíram de 312 para</MessageText>
        </Message>
        <Message author="Atlas" time="agora" grouped>
          <MessageText>continua</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    expect(first?.className).toBe("ac-msg ac-msg--agent ac-msg--streaming");
    expect(first?.getAttribute("aria-busy")).toBe("true");
    const time = first?.querySelector(".ac-msg__time--details");
    expect(document.getElementById(time?.getAttribute("aria-describedby") ?? "")?.textContent).toBe("escrevendo…");
    expect(second?.querySelector(".ac-avatar")).toBeNull();
    expect(second?.querySelector(".ac-visually-hidden")?.textContent).toContain("Atlas");
  });

  test("machine details live in a tooltip on the time; person-facing states show with an icon", () => {
    const { container } = render(
      <Message
        author="Ada"
        time="21:10"
        meta="sonnet 5.5 · 1.240 tokens · US$ 0,004"
        status={{ icon: "waiting", label: "enviando…" }}
        entering
        agent
      >
        <MessageText>Achei a causa.</MessageText>
      </Message>,
    );
    const article = container.querySelector("article");
    expect(article?.className).toContain("ac-msg--enter");
    const time = article?.querySelector(".ac-msg__time--details") as HTMLElement;
    expect(time.tabIndex).toBe(0);
    // Read out from the time itself; the tip that shows them opens on the floating layer (floating.test.tsx).
    const details = document.getElementById(time.getAttribute("aria-describedby") ?? "");
    expect(time.contains(details)).toBe(true);
    expect(details?.hidden).toBe(true);
    expect(details?.textContent).toBe("sonnet 5.5 · 1.240 tokens · US$ 0,004");
    const status = article?.querySelector(".ac-msg__status");
    expect(status?.textContent).toBe("enviando…");
    expect(status?.querySelector("svg")).not.toBeNull();
  });

  test("first and grouped messages share one text edge: a fixed avatar column or an equal gutter", async () => {
    const { container } = render(
      <>
        <Message avatar={<Avatar kind="agent" name="Jorge" />} author="Jorge" time="10:02" agent>
          <MessageText>Primeiro parágrafo.</MessageText>
          <MessageText>Segundo parágrafo.</MessageText>
          <div className="card">cartão</div>
        </Message>
        <Message author="Jorge" time="10:03" grouped>
          <MessageText>continua</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    // DOM order: avatar column (or gutter) first, then the text column with header, text and cards.
    expect(Array.from(first?.children ?? []).map((c) => c.className)).toEqual(["ac-msg__avatar", "ac-msg__body"]);
    expect(first?.querySelector(".ac-msg__avatar .ac-avatar")).not.toBeNull();
    const body1 = first?.querySelector(".ac-msg__body");
    expect(Array.from(body1?.children ?? []).map((c) => c.className)).toEqual([
      "ac-msg__head",
      "ac-msg__text",
      "ac-msg__text",
      "card",
    ]);
    expect(Array.from(second?.children ?? []).map((c) => c.className)).toEqual(["ac-msg__gutter", "ac-msg__body"]);
    // The gutter shows the time on hover; screen readers get it from the hidden header.
    const gutter = second?.querySelector(".ac-msg__gutter");
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    expect(gutter?.textContent).toBe("10:03");
    // CSS: top-aligned row, and the avatar column and the gutter have the same fixed width.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-msg")).toContain("align-items: flex-start");
    // One face size beside a name, in a message as in the sidebar's rows and a MediaRow: `--name-face`, 32.
    expect(css).toContain("--name-face: 32px;");
    expect(rule(".ac-msg__avatar,\n.ac-msg__gutter")).toContain("flex: 0 0 var(--name-face)");
    expect(rule(".ac-msg__avatar .ac-avatar:not(.ac-avatar--xs)")).toContain("width: var(--name-face)");
    expect(rule(".ac-mediarow")).toContain("--mediarow-face: var(--name-face);");
    expect(rule(".ac-msg__avatar")).toContain("align-self: flex-start");
  });
});

describe("Menu", () => {
  test("opens from its trigger with the keyboard and runs the item", async () => {
    let picked = "";
    render(
      <Menu trigger={<Button>Walter</Button>} label="Conta">
        <MenuItem onSelect={() => (picked = "theme")}>Tema escuro</MenuItem>
        <MenuItem onSelect={() => (picked = "out")}>Sair</MenuItem>
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Walter" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const menu = body().getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Tema escuro", "Sair"]);
    await act(async () => fireEvent.click(items[1] as HTMLElement));
    expect(picked).toBe("out");
    expect(body().queryByRole("menu")).toBeNull();
  });

  test("checkable items keep their check at the row's end, after the label and the hint", async () => {
    render(
      <Menu trigger={<Button>Filtros</Button>} label="Filtros">
        <MenuCheckboxItem checked={false} onCheckedChange={() => {}} hint={3}>
          Mostrar canceladas
        </MenuCheckboxItem>
        <MenuRadioGroup
          label="Ordem"
          value="new"
          onValueChange={() => {}}
          options={[
            { value: "new", label: "Mais novas", leading: <span>•</span> },
            { value: "old", label: "Mais antigas" },
          ]}
        />
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Filtros" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const menu = body().getByRole("menu");
    const box = within(menu).getByRole("menuitemcheckbox");
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect([...box.children].map((c) => c.getAttribute("class"))).toEqual([
      "ac-menu__label",
      "ac-menu__hint",
      "ac-menu__check",
    ]);
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(radios.map((r) => [...r.children].map((c) => c.getAttribute("class")))).toEqual([
      ["ac-menu__leading", "ac-menu__label", "ac-menu__check"],
      ["ac-menu__label", "ac-menu__check"],
    ]);
  });

  test("a checkable item with an icon starts with it, like the plain items around it", async () => {
    render(
      <Menu trigger={<Button>Mais</Button>} label="Mais">
        <MenuItem icon="layers">Nova coluna</MenuItem>
        <MenuCheckboxItem icon="eye" checked onCheckedChange={() => {}}>
          Mostrar canceladas
        </MenuCheckboxItem>
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Mais" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const box = within(body().getByRole("menu")).getByRole("menuitemcheckbox");
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect([...box.children].map((c) => c.getAttribute("class")?.split(" ")[0])).toEqual([
      "ac-icon",
      "ac-menu__label",
      "ac-menu__check",
    ]);
  });

  test("quick reactions end with a cell that opens every emoji", async () => {
    let picked = "";
    let more = 0;
    render(
      <Menu trigger={<Button>Mensagem</Button>} label="Ações">
        <MenuReactions
          label="Reagir"
          emojis={["👍", "🎉"]}
          onPick={(emoji) => (picked = emoji)}
          more={{ label: "Adicionar reação", onSelect: () => more++ }}
        />
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Mensagem" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const cells = within(body().getByRole("group", { name: "Reagir" })).getAllByRole("menuitem");
    expect(cells.map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual(["👍", "🎉", "Adicionar reação"]);
    // The add-reaction pill's own two icons.
    expect([...(cells[2]?.querySelectorAll("svg") ?? [])].map((svg) => svg.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
    ]);
    await act(async () => fireEvent.click(cells[2] as HTMLElement));
    expect(more).toBe(1);
    expect(picked).toBe("");
    expect(body().queryByRole("menu")).toBeNull();
  });

  test("a face on top that changes it is the first item the keys reach, named, with its glyph hidden from readers", async () => {
    let changed = 0;
    render(
      <Menu trigger={<Button>Walter</Button>} label="Conta">
        <div>
          <MenuFace label="Trocar foto" onSelect={() => changed++}>
            <Avatar name="Walter Lima" size="lg" presence="online" />
          </MenuFace>
          <span>Walter Lima</span>
        </div>
        <MenuItem>Sair</MenuItem>
      </Menu>,
    );
    const trigger = body().getByRole("button", { name: "Walter" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const items = within(body().getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("aria-label") ?? i.textContent)).toEqual(["Trocar foto", "Sair"]);
    const face = items[0] as HTMLElement;
    expect(document.activeElement).toBe(face);
    expect(face.className).toBe("ac-face-edit");
    expect(face.getAttribute("title")).toBe("Trocar foto");
    expect([...face.children].map((c) => c.getAttribute("class")?.split(" ")[0])).toEqual([
      "ac-avatar",
      "ac-face-edit__glyph",
      "ac-face-edit__badge",
    ]);
    for (const part of [".ac-face-edit__glyph", ".ac-face-edit__badge"])
      expect(face.querySelector(part)?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => fireEvent.keyDown(face, { key: "Enter" }));
    expect(changed).toBe(1);
    expect(body().queryByRole("menu")).toBeNull();
    // Shown on hover and while the keys hold it, over the tile's hairline and under the presence badge.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toContain(
      ".ac-face-edit:hover > .ac-face-edit__glyph,\n.ac-face-edit[data-highlighted] > .ac-face-edit__glyph {\n  opacity: 1;",
    );
    expect(css).toContain("html:not([data-pointer]) .ac-face-edit:focus-visible {\n  box-shadow: var(--focus-ring);");
    // Initials give way to the glyph, at the same pace; a photo stays under the scrim.
    expect(css).toContain(
      ".ac-face-edit:hover .ac-avatar__initials,\n.ac-face-edit[data-highlighted] .ac-avatar__initials {\n  opacity: 0;",
    );
    expect(css).toContain(".ac-face-edit .ac-avatar__initials {\n  transition: opacity 150ms var(--out);");
    const glyph = css.split(".ac-face-edit__glyph {")[1]?.split("}")[0] ?? "";
    expect(glyph).toContain("z-index: var(--z-raised);");
    expect(glyph).toContain("opacity: 0;");
    // No hover on a touch screen: the photo badge stays on the face's top corner there, and only there.
    expect(css).toContain(
      ".ac-face-edit__badge {\n  display: none;\n}\n@media (hover: none) {\n  .ac-face-edit__badge {",
    );
    const badge = css.split("@media (hover: none) {\n  .ac-face-edit__badge {")[1]?.split("}")[0] ?? "";
    for (const line of ["top: -4px;", "right: -4px;", "z-index: var(--z-lifted);", "display: grid;"])
      expect(badge).toContain(line);
  });
});

describe("Logo, Icon, Meter", () => {
  test("logo has an accessible name; the mark uses the agent token classes", () => {
    const { container } = render(
      <>
        <Logo />
        <Logo variant="expanded" />
      </>,
    );
    expect(body().getByRole("img", { name: "agentes" })).toBeTruthy();
    expect(body().getByRole("img", { name: "agentes.chat" }).textContent).toBe("agentes.chat");
    expect(container.querySelector(".ac-logo__body")).not.toBeNull();
  });

  test("every icon renders a stroke-only 20px glyph, decorative unless labelled", () => {
    for (const name of iconNames.filter((n) => n !== "spinner")) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.childElementCount).toBeGreaterThan(0);
      unmount();
    }
    render(<Icon name="search" label="Buscar" />);
    expect(body().getByRole("img", { name: "Buscar" })).toBeTruthy();
  });

  test("a name this build doesn't have (a table missing a newer server's kind) draws a plain ring, never an error", () => {
    for (const name of ["something.new", "constructor", undefined]) {
      const { container, unmount } = render(<Icon name={name as IconName} />);
      expect(container.querySelector("svg.ac-icon > circle")).not.toBeNull();
      unmount();
    }
  });

  test("the spinner icon is the pixel orbit everywhere (no ring), decorative, 14 or 16 px", () => {
    const { container, unmount } = render(<Icon name="spinner" size={14} className="x" />);
    const orbit = container.querySelector("canvas");
    expect(orbit?.getAttribute("class")).toBe("ac-pixspin ac-icon--orbit x");
    expect(orbit?.getAttribute("aria-hidden")).toBe("true");
    expect((orbit as HTMLElement).style.width).toBe("14px");
    expect(container.querySelector("svg")).toBeNull();
    unmount();
    const big = render(<Icon name="spinner" />);
    expect((big.container.querySelector("canvas") as HTMLElement).style.width).toBe("16px");
    big.unmount();
    const other = render(<Icon name="search" />);
    expect(other.container.querySelector("svg")?.getAttribute("class")).toBe("ac-icon");
    other.unmount();
  });

  test("meter exposes value and max", () => {
    render(<Meter value={12.3} max={40} label="Orçamento usado" />);
    const meter = body().getByRole("meter", { name: "Orçamento usado" });
    expect(meter.getAttribute("aria-valuenow")).toBe("12.3");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("31%");
  });

  test("steps: the ones before the current are done; the current is under way, not done (on the last one too)", () => {
    const bars = (current: number) => {
      const { container, unmount } = render(<Steps current={current} total={4} label={`Passo ${current} de 4`} />);
      const state = [...container.querySelectorAll(".ac-steps__bar")].map((b) =>
        b.hasAttribute("data-current") ? "now" : b.getAttribute("data-done") === "true" ? "done" : "",
      );
      unmount();
      return state;
    };
    expect(bars(1)).toEqual(["now", "", "", ""]);
    expect(bars(2)).toEqual(["done", "now", "", ""]);
    expect(bars(4)).toEqual(["done", "done", "done", "now"]);
  });
});

describe("Diff", () => {
  test("keeps equal lines, marks removed and added ones", async () => {
    const { diffLines } = await import("../src");
    const lines = diffLines(
      ["Programa em branches.", "Abre PRs pequenos.", "Pede ajuda ao João."],
      ["Programa em branches.", "Abre PRs de até 300 linhas.", "Abre PRs pequenos.", "Pede revisão do João."],
    );
    expect(lines).toEqual([
      { kind: "same", text: "Programa em branches." },
      { kind: "add", text: "Abre PRs de até 300 linhas." },
      { kind: "same", text: "Abre PRs pequenos." },
      { kind: "del", text: "Pede ajuda ao João." },
      { kind: "add", text: "Pede revisão do João." },
    ]);
  });

  test("blocks as a reader takes them in: runs joined, a long unchanged run cut to the line beside each change", async () => {
    const { diffBlocks, diffLines } = await import("../src");
    const before = [
      "# Atendimento",
      "Responde em português.",
      "Um",
      "Dois",
      "Três",
      "Quatro",
      "- Nunca promete prazo.",
    ];
    const after = [
      "# Atendimento",
      "Responde no idioma do cliente.",
      "Um",
      "Dois",
      "Três",
      "Quatro",
      "- Nunca promete prazo.",
    ];
    expect(diffBlocks(diffLines(before, after))).toEqual([
      { kind: "same", text: "# Atendimento" },
      { kind: "del", text: "Responde em português." },
      { kind: "add", text: "Responde no idioma do cliente." },
      { kind: "same", text: "Um" },
      { kind: "fold", count: 4 },
    ]);
    // Three unchanged lines or fewer stay whole; with no change at all, the text stays whole.
    expect(diffBlocks(diffLines(["a", "b", "c", "d"], ["a", "b", "c", "e"]))).toEqual([
      { kind: "same", text: "a\nb\nc" },
      { kind: "del", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(diffBlocks(diffLines(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"]))).toEqual([
      { kind: "same", text: "a\nb\nc\nd\ne" },
    ]);
  });

  test("prose: each block drawn by the caller, no mark column, a fold says how many lines it hides", async () => {
    const { Diff, diffLines } = await import("../src");
    const { container } = render(
      <Diff
        aria-label="Mudança"
        addedLabel="Adicionado: "
        removedLabel="Removido: "
        lines={diffLines(["a", "b", "c", "d", "velho"], ["a", "b", "c", "d", "novo"])}
        prose={{ render: (text) => <p className="md">{text}</p>, folded: (n) => `${n} linhas iguais` }}
      />,
    );
    expect(container.querySelector(".ac-diff__mark")).toBeNull();
    expect([...container.querySelectorAll(".ac-diff--prose > *")].map((b) => [b.className, b.textContent])).toEqual([
      ["ac-diff__fold", "3 linhas iguais"],
      ["ac-diff__block", "d"],
      ["ac-diff__block ac-diff__block--del", "Removido: velho"],
      ["ac-diff__block ac-diff__block--add", "Adicionado: novo"],
    ]);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toContain("box-shadow: inset 3px 0 0 var(--ok);");
    expect(css).toContain("box-shadow: inset 3px 0 0 var(--danger);");
  });

  test("renders lines with screen-reader labels", async () => {
    const { Diff } = await import("../src");
    const { container } = render(
      <Diff
        aria-label="Mudança"
        addedLabel="Adicionado: "
        removedLabel="Removido: "
        lines={[
          { kind: "del", text: "velho" },
          { kind: "add", text: "novo" },
        ]}
      />,
    );
    const [del, add] = Array.from(container.querySelectorAll(".ac-diff__line"));
    expect(del?.className).toContain("ac-diff__line--del");
    expect(del?.textContent).toBe("−Removido: velho");
    expect(add?.textContent).toBe("+Adicionado: novo");
  });
});

describe("Message aside and foot", () => {
  test("the aside ends the first line, the header's or a grouped message's text's; the foot is a line under both", () => {
    const { container } = render(
      <>
        <Message author="João" time="10:42" aside={<span>✓</span>} foot={<span>Ninguém vai responder</span>}>
          <MessageText>oi</MessageText>
        </Message>
        <Message author="João" time="10:43" grouped aside={<span>✓✓</span>} foot={<span>Ninguém vai responder</span>}>
          <MessageText>de novo</MessageText>
        </Message>
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll("article"));
    expect(first?.querySelector(".ac-msg__head .ac-msg__aside")?.textContent).toBe("✓");
    // Floated before the text, so the text's first line wraps before it.
    expect(second?.querySelector(".ac-msg__aside--floating + .ac-msg__text")?.textContent).toBe("de novo");
    expect(second?.querySelector(".ac-msg__aside--floating")?.textContent).toBe("✓✓");
    // The same line under the text on both: the text follows the name, and words that come and go never move it.
    for (const row of [first, second]) {
      expect(row?.querySelector(".ac-msg__body > :last-child")?.className).toBe("ac-msg__foot");
      expect(row?.querySelector(".ac-msg__head .ac-msg__foot")).toBeNull();
    }
  });

  test("my own row: the time and then the receipt under the turn's last bubble, no time in the far-left column", () => {
    const { container } = render(
      <>
        <Message author="Eu" time="8:39 PM" own run="start" aside={<span>✓</span>}>
          <MessageText>primeira</MessageText>
        </Message>
        <Message author="Eu" time="8:40 PM" own run="end" grouped aside={<span>✓✓</span>}>
          <MessageText>segunda</MessageText>
        </Message>
      </>,
    );
    const [start, end] = Array.from(container.querySelectorAll("article"));
    // A line under the bubble: time first, then the receipt (a button stays one).
    expect(end?.querySelector(".ac-msg__text + .ac-msg__own-foot")?.textContent).toBe("8:40 PM✓✓");
    expect(end?.querySelector(".ac-msg__own-time")?.getAttribute("aria-hidden")).toBe("true");
    expect(end?.querySelector(".ac-msg__own-foot > .ac-msg__aside")?.getAttribute("aria-hidden")).toBeNull();
    // A run's earlier row: no time, in the left column or under it.
    expect(start?.querySelector(".ac-msg__own-foot, .ac-msg__own-time")).toBeNull();
    for (const row of [start, end])
      expect(row?.querySelector(".ac-msg__gutter, .ac-msg__avatar, .ac-msg__aside--floating")).toBeNull();
  });

  test("every menu's rows share one dense height and side padding, as dense as the message's bar", async () => {
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const decls = (selector: string) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
        .map((m) => m[2] ?? "")
        .join(";");
    const value = (selector: string, prop: string) =>
      [...decls(selector).matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))].at(-1)?.[1]?.trim();
    expect(css).toContain(":root {\n  --menu-item-h: 32px;\n  --menu-item-px: 8px;\n  --menu-pad: var(--space-1);\n}");
    expect(value(".ac-menu__item", "padding")).toBe("calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px)");
    expect(value(".ac-menu__item", "min-height")).toBe("var(--menu-item-h)");
    expect(value(".ac-menu__item", "line-height")).toBe("20px");
    expect(value(".ac-menu__reaction", "height")).toBe("var(--menu-item-h)");
    expect(value(".ac-menu", "padding")).toBe("var(--menu-pad)");
    // No menu's rows taller than the bar's buttons by more than the token: nothing sets its own item height.
    expect(css).not.toMatch(/\.ac-menu__item\s*\{[^}]*min-height:\s*\d+px/);
  });

  test("the action bar is small and sits on the row's top edge, in one place on every row", async () => {
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const bodies = (selector: string, sheet = css) =>
      [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
        .map((m) => m[2] ?? "")
        .join(";");
    const value = (selector: string, prop: string, sheet = css) =>
      new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(bodies(selector, sheet))?.[1]?.trim();
    const bar = ".ac-msg__actions";
    // Placed by its middle, never by its bottom. 4px lower at rest, it slides up as it shows. One transform
    // (built-css.test.ts in the web app checks the built stylesheet keeps it).
    expect(value(bar, "transform")).toBe("translateY(calc(-50% + 4px))");
    expect(value(".ac-msg:hover .ac-msg__actions", "transform")).toBe("translateY(-50%)");
    expect(value("html:not([data-pointer]) .ac-msg:focus-within .ac-msg__actions", "transform")).toBe(
      "translateY(-50%)",
    );
    expect(bodies(bar)).not.toMatch(/(^|;)\s*(bottom|translate):/);
    // Its middle on the row's top edge, grouped or not: half of it in the gap above, never over the first line.
    expect(value(bar, "top")).toBe("0");
    expect(value(".ac-msg--grouped > .ac-msg__body > .ac-msg__actions", "top")).toBe("0");
    expect(
      bodies(".ac-msg--grouped:has(> .ac-msg__body > .ac-msg__foot:not(:empty)) > .ac-msg__body > .ac-msg__actions"),
    ).toBe("");
    // 26px plates around 16px icons, 2px around them, no gap: a 30px bar.
    for (const decl of [
      /(^|;)\s*gap:\s*0\s*(;|$)/,
      /--bar-pad:\s*2px\s*(;|$)/,
      /--bar-r:\s*10px\s*(;|$)/,
      /--bar-btn:\s*26px\s*(;|$)/,
      /--bar-icon:\s*16px\s*(;|$)/,
    ])
      expect(bodies(bar)).toMatch(decl);
    expect(value(".ac-msg__actions .ac-btn--sm", "width")).toBe("var(--bar-btn)");
    expect(value(".ac-msg__actions .ac-btn--sm", "height")).toBe("var(--bar-btn)");
    expect(value(".ac-msg__actions .ac-btn--sm .ac-icon", "width")).toBe("var(--bar-icon)");
    // A plate with its count (👍 1) is one plate around both: as tall, the icon as far from its start as in a square one.
    const counted = ".ac-msg__actions .ac-btn--sm:not(.ac-btn--icon)";
    expect(value(counted, "width")).toBe("auto");
    expect(value(counted, "padding-inline")).toBe("calc((var(--bar-btn) - var(--bar-icon)) / 2)");
    // Between the icon and its count, the small button's own gap (a token the geometry check knows).
    expect(value(counted, "gap")).toBeUndefined();
    // Pressed, it takes the bar's own plate (a ghost's): no fill of its own.
    expect(bodies('.ac-msg__actions .ac-btn[aria-pressed="true"]')).toBe("");
    // On touch a small button keeps its 32px plate and its target grows to 44 past it: one with words up and down
    // only, an icon 4px to each side too. The bar's 26px plates grow to the 32 of the rest, 8px apart, so the
    // targets of two side by side touch and never overlap.
    const touch = [...css.matchAll(/@media \(pointer: coarse\) \{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)]
      .map((m) => m[1] ?? "")
      .join("\n");
    expect(value(".ac-btn--sm", "min-height", touch)).toBeUndefined();
    expect(value(".ac-btn--sm.ac-btn--icon", "min-width", touch)).toBeUndefined();
    expect(value(":where(.ac-btn--sm)", "position", touch)).toBe("relative");
    expect(value(".ac-btn--sm::after", "position", touch)).toBe("absolute");
    expect(value(".ac-btn--sm::after", "inset", touch)).toBe("calc((var(--control-h-sm) - var(--touch-target)) / 2) 0");
    expect(value(".ac-btn--sm.ac-btn--icon::after", "inset", touch)).toBe(
      "calc((var(--control-h-sm) - var(--touch-target)) / 2) calc(-1 * var(--space-1))",
    );
    const tokens = await Bun.file(new URL("../src/styles/tokens.css", import.meta.url).pathname).text();
    expect(tokens).toContain("--touch-target: 44px;");
    const buttons = ".ac-msg__actions .ac-btn--sm";
    // Its plates, square or with a count, grow to the 32 of every small button there.
    expect(value(bar, "--bar-btn", touch)).toBe("var(--control-h-sm)");
    expect(value(`${buttons}::after`, "inset", touch)).toBeUndefined();
    expect(Number.parseFloat(value(bar, "gap", touch) ?? "")).toBe(8);
    // One place on every row: what a row holds at its end (a grouped message's check, a time) never moves the bar.
    const byContent = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector = "", body = ""]) =>
        /\.ac-msg__actions\s*$/.test(selector.trim()) &&
        selector.includes(":has(") &&
        !selector.includes(".ac-msg--own") &&
        /(^|;)\s*(right|left|top|inset)\s*:/.test(body),
    );
    expect(byContent.map(([, selector = ""]) => selector.trim())).toEqual([]);
    // So a grouped row's check at its line's end, under the bar, steps out of sight while the bar shows, keeping its
    // room: nothing overlaps and nothing moves. On a touch screen only while the bar is open.
    const hover = [...css.matchAll(/@media not \(hover: none\) \{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? "").join("\n");
    expect(
      value(
        ".ac-msg:hover:has(> .ac-msg__body > .ac-msg__actions) > .ac-msg__body > .ac-msg__aside--floating",
        "visibility",
        hover,
      ),
    ).toBe("hidden");
    expect(css.replace(/\s+/g, " ")).toContain(
      'html:not([data-pointer]) .ac-msg:focus-within:has(> .ac-msg__body > .ac-msg__actions) > .ac-msg__body > .ac-msg__aside--floating, .ac-msg:has(> .ac-msg__body > .ac-msg__actions:is([data-open="true"], :has([aria-expanded="true"]))) > .ac-msg__body > .ac-msg__aside--floating { visibility: hidden; }',
    );
    expect(value(".ac-msg--grouped > .ac-msg__body > .ac-msg__actions", "top")).toBe(value(bar, "top"));
    expect(value(".ac-receipt__check", "padding")).toBe("0 2px");
    expect(value(".ac-receipt__check .ac-icon", "width")).toBe("16px");
  });

  test("an aside or a foot with nothing in it takes no room, in a stacked body too", async () => {
    const Nothing = () => null;
    const { container } = render(
      <Message author="João" time="10:42" grouped stacked aside={<Nothing />} foot={<Nothing />}>
        <div className="ac-card">Issue</div>
      </Message>,
    );
    for (const part of [".ac-msg__aside", ".ac-msg__foot"]) {
      expect(container.querySelector(part)?.childNodes.length).toBe(0);
    }
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toContain(".ac-msg__aside:empty,\n.ac-msg__foot:empty {\n  display: none;\n}");
  });
});

describe("Message on touch", () => {
  /** A phone (touch points, no hover) or a computer with a mouse. */
  const device = (touch: boolean) => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: touch && query.includes("hover: none"),
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const points = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch ? 5 : 0 });
    return () => {
      media.mockRestore();
      if (points) Object.defineProperty(navigator, "maxTouchPoints", points);
      else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
    };
  };
  const row = (onReply: () => void) => (
    <Message
      author="João"
      time="10:43"
      grouped
      menu={{ label: "Ações da mensagem de João", items: <MenuItem onSelect={onReply}>Responder</MenuItem> }}
    >
      <MessageText>Os rótulos ficam com o verde antigo?</MessageText>
      <button type="button">Conectar</button>
    </Message>
  );

  test("a tap on the row opens its actions in a menu off the row and lights the row; a control keeps its own tap", async () => {
    const restore = device(true);
    try {
      let replied = 0;
      const { container } = render(row(() => replied++));
      const article = container.querySelector("article") as HTMLElement;
      await act(async () => fireEvent.click(body().getByRole("button", { name: "Conectar" })));
      expect(body().queryByRole("menu")).toBeNull();
      await act(async () => fireEvent.click(container.querySelector(".ac-msg__text") as HTMLElement));
      const menu = body().getByRole("menu", { name: "Ações da mensagem de João" });
      expect(article.getAttribute("data-menu-open")).toBe("true");
      // On the page, not in the row: a list's containment would make a fixed anchor the row's.
      expect(article.contains(menu)).toBe(false);
      await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Responder" })));
      expect(replied).toBe(1);
      expect(body().queryByRole("menu")).toBeNull();
      expect(article.hasAttribute("data-menu-open")).toBe(false);
    } finally {
      restore();
    }
  });

  /** The row's box on a screen `height` tall, 390 wide; and the box its menu opens beside (the menu's hidden anchor). */
  const layout = (article: HTMLElement) => {
    const own = Object.getOwnPropertyDescriptor(window, "innerHeight");
    return {
      place(height: number, top: number, bottom: number) {
        Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
        article.getBoundingClientRect = () =>
          ({ left: 0, right: 390, top, bottom, width: 390, height: bottom - top, x: 0, y: top }) as DOMRect;
      },
      anchor() {
        const style = (document.body.querySelector('span[aria-haspopup="menu"]') as HTMLElement).style;
        return [style.left, style.top, style.width, style.height];
      },
      restore() {
        if (own) Object.defineProperty(window, "innerHeight", own);
        else delete (window as { innerHeight?: number }).innerHeight;
      },
    };
  };

  test("the menu opens beside a long row while the larger side holds its reactions and most of two items, else at the tap", async () => {
    const restore = device(true);
    const { container } = render(row(() => {}));
    const article = container.querySelector("article") as HTMLElement;
    const screen = layout(article);
    const tap = () =>
      act(async () =>
        fireEvent.click(container.querySelector(".ac-msg__text") as HTMLElement, { clientX: 120, clientY: 400 }),
      );
    try {
      // A long reply at the end of a phone's list: 140px over it, so the menu opens over it and scrolls.
      screen.place(667, 140, 600);
      await tap();
      expect(screen.anchor()).toEqual(["0px", "140px", "390px", "460px"]);
      await act(async () => fireEvent.keyDown(body().getByRole("menu"), { key: "Escape" }));
      expect(body().queryByRole("menu")).toBeNull();
      // 139px over it and under it: the row fills the screen.
      screen.place(667, 139, 528);
      await tap();
      expect(screen.anchor()).toEqual(["120px", "400px", "0px", "0px"]);
    } finally {
      screen.restore();
      restore();
    }
  });

  test("the menu stays with its row when the page resizes (a keyboard going down) or the row moves, and goes with it", async () => {
    const restore = device(true);
    const { container } = render(row(() => {}));
    const article = container.querySelector("article") as HTMLElement;
    const screen = layout(article);
    const frames = () => act(() => new Promise((done) => setTimeout(done, 60)));
    try {
      screen.place(500, 300, 340);
      await act(async () => fireEvent.click(container.querySelector(".ac-msg__text") as HTMLElement));
      expect(screen.anchor()).toEqual(["0px", "300px", "390px", "40px"]);
      screen.place(844, 560, 600);
      await act(async () => window.dispatchEvent(new Event("resize")));
      await frames();
      expect(body().getByRole("menu", { name: "Ações da mensagem de João" })).toBeTruthy();
      expect(screen.anchor()).toEqual(["0px", "560px", "390px", "40px"]);
      screen.place(844, 520, 560);
      await act(async () => container.dispatchEvent(new Event("scroll")));
      await frames();
      expect(screen.anchor()).toEqual(["0px", "520px", "390px", "40px"]);
      // With no event at all: a row above drawn at its own height again.
      screen.place(844, 575, 615);
      await frames();
      expect(screen.anchor()).toEqual(["0px", "575px", "390px", "40px"]);
      expect(article.getAttribute("data-menu-open")).toBe("true");
      screen.place(844, 900, 940);
      await frames();
      expect(body().queryByRole("menu")).toBeNull();
      expect(article.hasAttribute("data-menu-open")).toBe(false);
    } finally {
      screen.restore();
      restore();
    }
  });

  test("with a mouse a click opens nothing: the row's bar has the actions", async () => {
    const restore = device(false);
    try {
      const { container } = render(row(() => {}));
      await act(async () => fireEvent.click(container.querySelector(".ac-msg__text") as HTMLElement));
      expect(body().queryByRole("menu")).toBeNull();
      expect(container.querySelector("article")?.hasAttribute("data-menu-open")).toBe(false);
    } finally {
      restore();
    }
  });

  test("on touch the bar is the keyboard's, the lit row is a step above a hover, and the menu's targets are 40px", async () => {
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const block = (media: string) =>
      [...css.matchAll(new RegExp(`@media \\(${media}\\) \\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`, "g"))]
        .map((m) => m[1] ?? "")
        .join("\n");
    const rule = (selector: string, sheet = css) =>
      [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").replace(/\s+/g, " ").trim() === selector)
        .map((m) => (m[2] ?? "").replace(/\s+/g, " ").trim())
        .join(" ");
    // A hover a tap leaves behind, a tap on a control in the row or in a field one types in (`:focus-visible` after a
    // tap too), never shows the bar on the text; Tab still does, and so does a picker or a dialog opened from it.
    expect(
      rule(
        '.ac-msg:is(:hover, :focus-within):not(:has(:focus-visible:not(:read-write))) .ac-msg__actions:not([data-open="true"], :has([aria-expanded="true"]))',
        block("hover: none"),
      ),
    ).toBe("opacity: 0; pointer-events: none;");
    expect(rule(".ac-msg:hover")).toBe("background: var(--plate-soft);");
    expect(rule('.ac-msg[data-menu-open="true"]')).toBe("background: var(--plate);");
    expect(css.indexOf('.ac-msg[data-menu-open="true"]')).toBeGreaterThan(css.indexOf(".ac-msg:hover {"));
    expect(rule(":root", block("pointer: coarse"))).toContain("--menu-item-h: 40px;");
    expect(rule(".ac-menu__reaction", block("pointer: coarse"))).toBe("width: 40px;");
  });
});

describe("ListRow and RunMark", () => {
  test("a list row is a neutral button: its lead on the title's first line, the title whole, meta", async () => {
    let clicked = 0;
    const { container } = render(
      <ListRow
        lead={<Icon name="calendar" />}
        title="Revisão do roadmap"
        meta="Hoje · 21:00"
        onClick={() => clicked++}
      />,
    );
    const row = within(container).getByRole("button", { name: /Revisão do roadmap/ });
    expect(row.getAttribute("type")).toBe("button");
    expect(row.className).toBe("ac-row ac-iconline");
    expect(row.querySelector(".ac-row__title")?.textContent).toBe("Revisão do roadmap");
    expect(row.querySelector(".ac-row__meta")?.textContent).toBe("Hoje · 21:00");
    fireEvent.click(row);
    expect(clicked).toBe(1);
    // A long title wraps: never "…" with the rest only on hover.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-row__title")).not.toContain("ellipsis");
    expect(rule(".ac-row__title")).toContain("overflow-wrap: anywhere");
    expect(rule(".ac-row")).toContain("align-items: flex-start");
  });

  test("a run mark is a decorative 8px canvas carrying its status", () => {
    const { container } = render(<RunMark color="sky" status="failed" />);
    const mark = container.querySelector("canvas.ac-run-mark") as HTMLCanvasElement;
    expect(mark.getAttribute("role")).toBeNull();
    expect(mark.dataset.status).toBe("failed");
    expect(mark.style.width).toBe("8px");
  });
});

describe("text and faces that are never cut", () => {
  test("an empty state's text wraps in even lines; initials in a stack keep their whole tile", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-empty__text")).toContain("text-wrap: balance");
    expect(rule('.ac-avatar-stack > .ac-avatar[data-kind="person"]:not(:has(img)) + .ac-avatar')).toContain(
      "margin-left: 0",
    );
    // The tiles that rule tells apart: initials have no image, a photo does.
    render(
      <AvatarStack>
        <Avatar name="Marina Alves" size="sm" />
        <Avatar name="Theo" size="sm" kind="agent" />
      </AvatarStack>,
    );
    const [initials, agent] = Array.from(document.querySelectorAll(".ac-avatar-stack > .ac-avatar"));
    expect(initials?.getAttribute("data-kind")).toBe("person");
    expect(initials?.querySelector("img")).toBeNull();
    expect(initials?.textContent).toBe("MA");
    expect(agent?.getAttribute("data-kind")).toBe("agent");
  });
});

describe("FilterChip", () => {
  test("each option starts with its face and name; the check sits at its end, kept empty when off", async () => {
    render(
      <FilterChip
        label="Papel"
        icon="person"
        clearLabel="Limpar Papel"
        multiple
        value={["admin"]}
        onChange={() => {}}
        options={[
          { value: "admin", label: "Admin", leading: <span className="face">A</span> },
          { value: "member", label: "Membro" },
        ]}
      />,
    );
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Papel: Admin" })));
    const options = within(body().getByRole("listbox", { name: "Papel" })).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(options.map((o) => [...o.children].map((c) => c.getAttribute("class")))).toEqual([
      ["face", "ac-filter__label", "ac-tz__check"],
      ["ac-filter__label", "ac-tz__check"],
    ]);
    expect(options[0]?.querySelector(".ac-tz__check svg")).not.toBeNull();
    expect(options[1]?.querySelector(".ac-tz__check svg")).toBeNull();
  });
});
