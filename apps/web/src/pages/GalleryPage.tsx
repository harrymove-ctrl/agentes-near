import {
  ApprovalCard,
  Avatar,
  AvatarStack,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CheckboxPill,
  Chip,
  Composer,
  CountBadge,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Diff,
  diffLines,
  EmptyState,
  Field,
  FilterToggle,
  GroupHeading,
  Icon,
  InfoHint,
  Input,
  iconNames,
  Logo,
  Mention,
  Menu,
  MenuItem,
  Message,
  MessageText,
  Meter,
  OptionCard,
  PageHeader,
  RadioCard,
  RadioGroup,
  SearchField,
  Select,
  Steps,
  Switch,
  TabPanel,
  Tabs,
  Toolbar,
} from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useTheme } from "@/lib/theme";

/*
 * Development-only gallery (`/dev/gallery`). The sample content below is
 * the design's demo copy and is not shipped: the route is
 * unreachable in production builds.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-section" aria-label={title}>
      <GroupHeading title={title} />
      {children}
    </section>
  );
}

export function GalleryPage() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [role, setRole] = useState("member");
  const [check, setCheck] = useState(true);
  const [radio, setRadio] = useState("platform");
  const [draft, setDraft] = useState("");
  const [find, setFind] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [sent, setSent] = useState<string[]>([]);
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pressed, setPressed] = useState("qa");
  const [checkFirst, setCheckFirst] = useState(true);
  const [hintDialog, setHintDialog] = useState(false);
  const about = (label: string) => t("common.about", { label });
  const items = ["Ler código e issues", "Abrir e comentar PRs", "Fazer merge"].filter((i) =>
    i.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <main className="page page--wide" style={{ minHeight: "100vh" }}>
      <PageHeader
        title={t("gallery.title")}
        meta={t("gallery.subtitle")}
        actions={
          <Button onClick={() => theme.setPreference(theme.resolved === "dark" ? "light" : "dark")}>
            {theme.resolved === "dark" ? t("shell.themeLight") : t("shell.themeDark")}
          </Button>
        }
      />

      <Section title="Logo">
        <div className="row" style={{ gap: 32 }}>
          <Logo size={32} />
          <Logo variant="expanded" size={32} />
          <Logo mono size={24} />
        </div>
      </Section>

      <Section title="Button">
        <div className="row">
          <Button variant="primary">Aprovar merge</Button>
          <Button>Recusar</Button>
          <Button variant="agent">Pedir à Ada</Button>
          <Button variant="danger">Revogar</Button>
          <Button variant="ghost">Ver diff</Button>
          <Button iconOnly icon="search" aria-label="Buscar" />
          <Button size="sm">Ver execuções</Button>
          <Button disabled>Criar Iris</Button>
        </div>
      </Section>

      <Section title="Field · Input · Select">
        <div className="grid-fields">
          <Field
            label="E-mail"
            id="g-email"
            hint={{ name: "Sobre E-mail", text: "O convite vale só para este e-mail." }}
          >
            <Input placeholder="nome@empresa.com.br" />
          </Field>
          <Field label="Orçamento mensal (US$)" id="g-budget" error="Use um valor maior que zero.">
            <Input defaultValue="0" />
          </Field>
          <Field label="Papel" id="g-role">
            <Select
              value={role}
              onValueChange={setRole}
              options={[
                { value: "member", label: "Membro", description: "Conversa, cria issues, aprova os próprios agentes" },
                { value: "owner", label: "Dono", description: "Pode tudo, inclusive passar a posse do workspace" },
              ]}
            />
          </Field>
        </div>
      </Section>

      <Section title="InfoHint">
        <div className="grid-fields">
          <Field
            label="Fuso horário"
            id="g-zone"
            hint={{ name: about("Fuso horário"), text: "Rotinas, lembretes e o calendário seguem este fuso." }}
          >
            <Input defaultValue="America/Sao_Paulo" />
          </Field>
        </div>
        <div className="row">
          <span className="ac-hintline">
            <label htmlFor="g-check-first">Agentes conferem o que o time já fez</label>
            <InfoHint name={about("Agentes conferem o que o time já fez")} id="g-check-first-hint">
              Antes de agir, o agente procura se alguém do time já fez o mesmo e avisa no lugar de repetir.
            </InfoHint>
          </span>
          <Switch
            id="g-check-first"
            checked={checkFirst}
            onCheckedChange={setCheckFirst}
            aria-describedby="g-check-first-hint"
          />
          <Button onClick={() => setHintDialog(true)}>Abrir num diálogo</Button>
        </div>
        <Card padded>
          <CardHeader
            mark="anthropic"
            title="Seu plano do Claude"
            hint={{
              name: about("Seu plano do Claude"),
              text: "A conta fica no computador do workspace, e só ele usa.",
            }}
          />
        </Card>
        <Dialog
          open={hintDialog}
          onOpenChange={setHintDialog}
          title="Novo agente"
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogBody>
            <Field
              label="Orçamento mensal (US$)"
              id="g-hint-budget"
              hint={{
                name: about("Orçamento mensal"),
                text: "No limite, o agente para e avisa quem é responsável por ele.",
              }}
            >
              <Input defaultValue="40" />
            </Field>
          </DialogBody>
        </Dialog>
      </Section>

      <Section title="Toolbar · SearchField · FilterToggle">
        <Toolbar
          label="Filtros"
          search={
            <SearchField
              aria-label="Buscar"
              placeholder="Buscar"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onClear={() => setFind("")}
              clearLabel="Limpar busca"
            />
          }
          actions={<Button size="sm">Ação</Button>}
        >
          <FilterToggle pressed={!onlyMine} onPressedChange={() => setOnlyMine(false)} count={6}>
            Todas
          </FilterToggle>
          <FilterToggle icon="person" pressed={onlyMine} onPressedChange={setOnlyMine} count={2}>
            Minhas
          </FilterToggle>
        </Toolbar>
      </Section>

      <Section title="Checkbox · Radio · Option">
        <div className="row">
          <Checkbox id="g-c" checked={check} onCheckedChange={setCheck} />
          <label htmlFor="g-c">Ler arquivos</label>
          <CheckboxPill id="g-p" checked={check} onCheckedChange={setCheck}>
            #eng
          </CheckboxPill>
          <Checkbox id="g-d" checked disabled aria-label="Fazer merge" />
        </div>
        <RadioGroup value={radio} onValueChange={setRadio} aria-label="Chave" style={{ display: "grid", gap: 8 }}>
          <RadioCard
            value="platform"
            id="g-r1"
            checked={radio === "platform"}
            title="Chave do agentes"
            description="Mais simples."
          />
          <RadioCard
            value="own"
            id="g-r2"
            checked={radio === "own"}
            title="Chave da Acme"
            description="Use a sua chave do Claude."
          />
        </RadioGroup>
        <div className="grid-options grid-options--sm">
          {["dev", "qa"].map((id) => (
            <OptionCard key={id} agent stacked pressed={pressed === id} onClick={() => setPressed(id)}>
              <span className="ac-option__title">{id.toUpperCase()}</span>
              <span className="ac-option__desc">Testa fluxos e reproduz bugs relatados.</span>
            </OptionCard>
          ))}
        </div>
      </Section>

      <Section title="Avatar · Chip · Badge">
        <div className="row">
          <Avatar name="Marina" />
          <Avatar name="João" presence="online" />
          <Avatar name="Ana" size="sm" presence="away" />
          <Avatar name="Bruno" size="sm" presence="busy" />
          <Avatar name="Lia" size="lg" presence="offline" />
          <AgentAvatar name="Ada" presence="busy" />
          <AgentAvatar name="Atlas" initials="At" running />
          <AgentAvatar name="Lia" size="lg" />
          <AgentAvatar name="Theo" size="sm" />
          <AvatarStack>
            <Avatar size="sm" name="W" />
            <Avatar size="sm" name="J" />
            <AgentAvatar size="sm" name="A" />
          </AvatarStack>
          <Chip icon="waiting" tone="waiting">
            Aguardando você
          </Chip>
          <Chip icon="check" tone="done">
            Aprovado por você · agora
          </Chip>
          <Chip icon="close">Recusado</Chip>
          <CountBadge>2</CountBadge>
        </div>
      </Section>

      <Section title="Message · Mention · Composer">
        <div>
          <Message avatar={<Avatar name="João" />} author="João" time="10:42">
            <MessageText>
              <Mention>@Ada</Mention> o login está devolvendo 401 desde o deploy das 9h. Consegue olhar?
            </MessageText>
          </Message>
          <Message
            avatar={<AgentAvatar name="Ada" />}
            author="Ada"
            time="10:43"
            meta="sonnet 5.5 · 1.240 tokens · US$ 0,004"
            agent
          >
            <MessageText>
              Achei a causa: o refresh compara <code>expires_at</code> em segundos com milissegundos.
            </MessageText>
          </Message>
          <Message
            avatar={<AgentAvatar name="Atlas" initials="At" running />}
            author="Atlas"
            time="agora"
            meta="escrevendo…"
            agent
            streaming
          >
            <MessageText>Os 401 no Sentry caíram de 312 para</MessageText>
          </Message>
          {sent.map((text, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: demo list
            <Message key={i} avatar={<Avatar name="Walter" />} author="Walter" time="agora">
              <MessageText>{text}</MessageText>
            </Message>
          ))}
        </div>
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={(text) => {
            setSent((s) => [...s, text]);
            setDraft("");
          }}
          label="Mensagem para #eng"
          placeholder="Mensagem para #eng · use @ para chamar um agente"
          sendLabel="Enviar"
          attachLabel="Anexar arquivo"
        />
      </Section>

      <Section title="ApprovalCard">
        <ApprovalCard
          status="waiting"
          who={
            <>
              <b>Ada</b> pede aprovação
            </>
          }
          statusLabel="Aguardando você"
          title="Fazer merge do PR #42 em main"
          detail="github.merge · agentes-chat/app · PR 42 · testes passando · expira em 23 h"
          actions={
            <>
              <Button variant="primary" size="sm">
                Aprovar merge
              </Button>
              <Button size="sm">Recusar</Button>
              <Button variant="ghost" size="sm">
                Ver diff
              </Button>
            </>
          }
        />
        <ApprovalCard
          compact
          status="approved"
          who={
            <>
              <b>Ada</b> · merge do PR #42 em main
            </>
          }
          statusLabel="Aprovado por você · agora"
        />
      </Section>

      <Section title="Tabs · Menu · Dialog · Meter · Steps">
        <Tabs
          value={tab}
          onValueChange={setTab}
          label="Filtro"
          items={[
            { value: "pending", label: "Pendentes", count: 2 },
            { value: "done", label: "Decididas", count: 2 },
          ]}
        >
          <TabPanel value={tab}>
            <EmptyState icon="waiting">Nenhuma aprovação pendente.</EmptyState>
          </TabPanel>
        </Tabs>
        <div className="row">
          <Menu trigger={<Button>Abrir menu</Button>}>
            <MenuItem icon="settings">Configurações da organização</MenuItem>
            <MenuItem>Sair</MenuItem>
          </Menu>
          <Button onClick={() => setOpen(true)}>Editar permissões</Button>
        </div>
        <Meter value={12.3} max={40} label="Orçamento usado" />
        <Steps current={2} total={4} label="Passo 2 de 4 · Contexto" />
        <Dialog open={open} onOpenChange={setOpen} title="Permissões da Ada" closeLabel={t("common.close")}>
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel="Buscar permissões"
            searchPlaceholder="Buscar permissão ou conector"
            isEmpty={items.length === 0}
            emptyText={`Nada encontrado com “${q}”.`}
          >
            {items.map((i) => (
              <div key={i} className="scope-row">
                <Checkbox id={`g-${i}`} checked onCheckedChange={() => {}} />
                <label htmlFor={`g-${i}`}>{i}</label>
              </div>
            ))}
          </DialogSearchList>
          <DialogFooter bar note="Merge, deploy e rollback sempre pedem aprovação.">
            <Button variant="primary" onClick={() => setOpen(false)}>
              Concluir
            </Button>
          </DialogFooter>
        </Dialog>
      </Section>

      <Section title="Diff">
        <Diff
          addedLabel="Adicionado: "
          removedLabel="Removido: "
          lines={diffLines(
            ["Programa em branches, nunca direto na main.", "Pede ajuda ao João quando a mudança tocar em pagamentos."],
            [
              "Programa em branches, nunca direto na main.",
              "Antes de abrir PR que toque em pagamentos, pede revisão do João no canal.",
            ],
          )}
        />
      </Section>

      <Section title="Icon">
        <div className="row">
          {iconNames.map((name) => (
            <span key={name} className="row small muted" style={{ gap: 4, width: 120 }}>
              <Icon name={name} />
              {name}
            </span>
          ))}
        </div>
      </Section>
    </main>
  );
}
