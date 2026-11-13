/**
 * Mention eval (ADR 0034, ADR 0089 and its addendum of 2026-11-10): when an agent's
 * message @mentions another agent, does it leave it nothing to do (no run: credit,
 * a source, a thanks, an "ok", a sign-off, a quote or a name, a plan to ask it
 * later), or does it plainly ask it something (a run: a request, a question, work
 * handed to it, the answer to its own question)? Scores every case with the
 * production judge (`mentionNeedsNothing`) and the production threshold
 * (`MENTION_WAKE_THRESHOLD`: it wakes only when the judge reads a request), with
 * the message it answers when there is one. Between agents with no turn cap, it
 * also tells a hand-back of the work or a question back (a run) from a thanks, an
 * "ok" or a 👍, an agreement or a sign-off (none), in Portuguese, English,
 * Spanish, German, Japanese and Arabic. It passes when every case is right.
 *
 * Two more judgments of agents working together (ADR 0095), in the same six
 * languages and at production thresholds: whether the sender of a note
 * (`tell_agent`) needs its reply (`noteReplyMatters`, 0.5: an acknowledgement,
 * a thanks or "nothing came yet, I'll take it when it comes" is nothing; a
 * result, a "couldn't" or a question back is something), and whether an
 * agent answering another in their DM stopped on a promise
 * (`followThroughVerdict`, unkept at 0.6: "I'll do it later" is, a result or
 * "I handed part of it on" isn't).
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/mention-handoff.ts [--judge jev|llm]
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production) or `ANTHROPIC_API_KEY` for
 * the LLM fallback (`EVAL_LLM_MODEL`, default claude-haiku-5-5).
 */
import { createAnthropicProvider } from "@agenteschat/providers";
import { noteReplyMatters } from "../src/consultations";
import { followThroughVerdict } from "../src/follow-through";
import { createJevJudge, createLlmJudge, type Judge, MENTION_WAKE_THRESHOLD, mentionNeedsNothing } from "../src/judge";

interface Case {
  id: string;
  /** True when the mentioned agent should wake: the message needs something from it. */
  wakes: boolean;
  from: string;
  to: { handle: string; name: string; role: string };
  body: string;
  /** The message it answers (the trigger of the author's run). */
  answering?: { from: string; text: string };
}

const ada = { handle: "ada", name: "Ada", role: "Engenharia" };
const theo = { handle: "theo", name: "Theo", role: "Produto" };
const nina = { handle: "nina", name: "Nina", role: "Dados" };
const atlas = { handle: "atlas", name: "Atlas", role: "Observabilidade" };

const CASES: Case[] = [
  {
    id: "offer-after-approval",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Quatro dos cinco negativos aconteceram logo depois de `subscription_completed`, e as cinco pessoas são Pro. O último positivo foi em 16/10. Na prática, pedir a avaliação logo depois da compra só tem gerado negativos. Minha recomendação é tirar o prompt desse momento e deixar só gatilhos de uso, como exportar o PDF ou terminar uma viagem. Se você concordar, abro a issue para a @ada.",
  },
  {
    id: "if-you-want",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Se quiser, peço para a @ada abrir o PR ainda hoje.",
  },
  {
    id: "past-work",
    wakes: false,
    from: "theo",
    to: ada,
    body: "A @ada já corrigiu isso ontem no PR #412, está em produção.",
  },
  {
    id: "asks-person-who",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Walter, você prefere que eu cuide disso ou que a @ada pegue?",
  },
  {
    id: "talk-to",
    wakes: false,
    from: "theo",
    to: nina,
    body: "Fala com a @nina, ela tem os dados de churn por plano.",
  },
  {
    id: "after-approval",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Depois que você aprovar o texto, a @ada consegue subir a mudança.",
  },
  {
    id: "en-offer",
    wakes: false,
    from: "theo",
    to: ada,
    body: "I'd drop the review prompt after checkout. Want me to open an issue for @ada?",
  },
  {
    id: "direct-request",
    wakes: true,
    from: "theo",
    to: ada,
    body: "@ada, pode abrir o PR que tira o prompt de review depois da compra?",
  },
  {
    id: "data-pull",
    wakes: true,
    from: "theo",
    to: nina,
    body: "@nina puxa os números de churn de setembro por plano, por favor.",
  },
  {
    id: "issue-assigned",
    wakes: true,
    from: "theo",
    to: ada,
    body: "Abri a issue #131. @ada, é contigo: o timeout está no cálculo de frete.",
  },
  {
    id: "question-now",
    wakes: true,
    from: "theo",
    to: atlas,
    body: "@atlas você viu algum erro novo no Sentry desde as 14h?",
  },
  {
    id: "approved-go",
    wakes: true,
    from: "theo",
    to: ada,
    body: "O Walter aprovou. @ada, segue com o PR que tira o prompt depois da compra.",
  },
  {
    id: "en-request",
    wakes: true,
    from: "theo",
    to: nina,
    body: "@nina can you pull last week's signups by source?",
  },
  {
    id: "findings-then-ask",
    wakes: true,
    from: "atlas",
    to: ada,
    body: "Taxa de erro subiu para 3% no checkout desde as 14h, tudo no `calcShipping`. @ada, consegue olhar agora?",
  },
  // Production misses under the old question (2026-10-30/31), anonymized: each needed the agent it named.
  {
    id: "handover-delivered",
    wakes: true,
    from: "theo",
    to: nina,
    body: "@nina, aqui está o documento completo da passagem da contabilidade: contas a pagar de novembro, os fornecedores com contrato vencendo e o calendário de fechamento. Está em Financeiro/Passagem, com a planilha de conciliação junto.",
    answering: { from: "a person", text: "Theo, passa tudo da contabilidade para a Nina antes de sexta." },
  },
  // A summary that asks nothing of the agent it names: since the addendum of 2026-11-10, credit, not a request.
  {
    id: "verdict-summary-at-the-end",
    wakes: false,
    from: "ada",
    to: theo,
    body: "Li o diff dos dois PRs e rodei os testes: 312 passaram, 4 ignorados.\n\n#12, aprovar com ressalvas: a importação agora valida o CSV antes de gravar. Falta um teste para o arquivo vazio.\n\n#13, aprovar: só testes e documentação.\n\n@theo, o resumo é esse.",
    answering: { from: "a person", text: "@ada consegue revisar o #12 e o #13 agora?" },
  },
  // A plan to ask later: the author asks with tell_agent, the mention alone wakes nobody.
  {
    id: "ill-ask-for-review",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Walter, o PR #12 já está aberto. Vou pedir para a @ada revisar antes de chegar até você.",
  },
  {
    id: "en-ill-ask-for-review",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Walter, PR #12 is open now. I'll ask @ada to review it before it goes to you.",
  },
  {
    id: "couldnt-report",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Marina, a @ada não conseguiu abrir o arquivo do relatório, então não vou pedir para ela de novo. Sigo com a planilha.",
  },
  {
    id: "checked-handback",
    wakes: true,
    from: "theo",
    to: ada,
    body: "@ada revisei os números que você pediu, tudo certo.",
    answering: { from: "ada", text: "@theo confere os números do resumo antes de eu mandar?" },
  },
  {
    id: "as-said",
    wakes: false,
    from: "theo",
    to: ada,
    body: "Como a @ada disse, o timeout está no cálculo de frete; o resto do checkout está normal.",
  },
];

type Kind = "handback" | "question_back" | "thanks" | "ack" | "agreement" | "sign_off";

/**
 * The same six moments of Theo and Ada working together, in each language: Ada hands Theo back the review he asked
 * for and asks him something back (both hand-offs), and Theo thanks her, says "ok" (or 👍), agrees with what she is
 * already doing or signs off (no hand-off, even addressed).
 */
const TOGETHER: Record<string, Record<Kind, { answering: string; body: string }>> = {
  pt: {
    handback: {
      answering: "@ada pode revisar o PR #12 antes do deploy?",
      body: "@theo revisei o PR #12: deixei dois comentários nos testes de checkout, é contigo para corrigir.",
    },
    question_back: { answering: "@ada puxa o churn de setembro?", body: "@theo você quer por plano ou só o total?" },
    thanks: { answering: "@theo churn de setembro: 3,2% no total, 5% no Pro.", body: "Valeu, @ada!" },
    ack: { answering: "@theo subi a correção, o CI está rodando.", body: "@ada ok" },
    agreement: {
      answering: "@theo já estou abrindo a issue do timeout, te aviso quando estiver pronta.",
      body: "@ada combinado, pode seguir.",
    },
    sign_off: { answering: "@theo corrigi os testes e o CI passou.", body: "@ada perfeito, por aqui está fechado." },
  },
  en: {
    handback: {
      answering: "@ada can you review PR #12 before the deploy?",
      body: "@theo reviewed PR #12: I left two comments on the checkout tests, over to you to fix them.",
    },
    question_back: {
      answering: "@ada can you pull September's churn?",
      body: "@theo do you want it by plan or just the total?",
    },
    thanks: { answering: "@theo September churn: 3.2% overall, 5% on Pro.", body: "Thanks, @ada!" },
    ack: { answering: "@theo pushed the fix, CI is running.", body: "@ada 👍" },
    agreement: {
      answering: "@theo I'm opening the timeout issue now, I'll ping you when it's ready.",
      body: "@ada agreed, go ahead.",
    },
    sign_off: { answering: "@theo fixed the tests and CI is green.", body: "@ada perfect, all done on my side." },
  },
  es: {
    handback: {
      answering: "@ada ¿puedes revisar el PR #12 antes del deploy?",
      body: "@theo revisé el PR #12: dejé dos comentarios en los tests de checkout, te toca corregirlos.",
    },
    question_back: {
      answering: "@ada ¿puedes sacar el churn de septiembre?",
      body: "@theo ¿lo quieres por plan o solo el total?",
    },
    thanks: { answering: "@theo churn de septiembre: 3,2% en total, 5% en Pro.", body: "¡Gracias, @ada!" },
    ack: { answering: "@theo subí la corrección, el CI está corriendo.", body: "@ada vale" },
    agreement: {
      answering: "@theo ya estoy abriendo la issue del timeout, te aviso cuando esté lista.",
      body: "@ada de acuerdo, adelante.",
    },
    sign_off: { answering: "@theo arreglé los tests y el CI pasó.", body: "@ada perfecto, por mi parte está cerrado." },
  },
  de: {
    handback: {
      answering: "@ada kannst du PR #12 vor dem Deploy reviewen?",
      body: "@theo PR #12 ist reviewt: zwei Kommentare zu den Checkout-Tests, jetzt bist du mit dem Fixen dran.",
    },
    question_back: {
      answering: "@ada kannst du den Churn vom September ziehen?",
      body: "@theo willst du ihn pro Plan oder nur gesamt?",
    },
    thanks: { answering: "@theo Churn im September: 3,2 % gesamt, 5 % bei Pro.", body: "Danke, @ada!" },
    ack: { answering: "@theo Fix ist gepusht, die CI läuft.", body: "@ada 👍" },
    agreement: {
      answering: "@theo ich lege gerade das Issue zum Timeout an und melde mich, wenn es steht.",
      body: "@ada passt, mach weiter.",
    },
    sign_off: {
      answering: "@theo Tests gefixt, die CI ist grün.",
      body: "@ada super, von meiner Seite ist alles erledigt.",
    },
  },
  ja: {
    handback: {
      answering: "@ada デプロイ前にPR #12をレビューしてもらえますか？",
      body: "@theo PR #12をレビューしました。チェックアウトのテストに2件コメントを残したので、修正をお願いします。",
    },
    question_back: {
      answering: "@ada 9月のチャーンを出してもらえますか？",
      body: "@theo プラン別がいいですか、それとも合計だけですか？",
    },
    thanks: { answering: "@theo 9月のチャーンは全体で3.2%、Proで5%です。", body: "@ada ありがとう！" },
    ack: { answering: "@theo 修正をプッシュしました。CIが走っています。", body: "@ada 了解" },
    agreement: {
      answering: "@theo タイムアウトのissueを今作っています。できたら知らせます。",
      body: "@ada いいですね、そのまま進めてください。",
    },
    sign_off: { answering: "@theo テストを直してCIも通りました。", body: "@ada 完璧です、こちらはこれで完了です。" },
  },
  ar: {
    handback: {
      answering: "@ada هل يمكنك مراجعة PR #12 قبل النشر؟",
      body: "@theo راجعت PR #12: تركت تعليقين على اختبارات الدفع، الدور عليك لإصلاحهما.",
    },
    question_back: {
      answering: "@ada هل يمكنك استخراج معدل الإلغاء لشهر سبتمبر؟",
      body: "@theo هل تريده حسب الخطة أم الإجمالي فقط؟",
    },
    thanks: { answering: "@theo معدل الإلغاء في سبتمبر: 3.2% إجمالاً و5% في Pro.", body: "شكراً يا @ada!" },
    ack: { answering: "@theo رفعت الإصلاح، والـ CI يعمل الآن.", body: "@ada تمام" },
    agreement: {
      answering: "@theo أفتح الآن مشكلة المهلة، وسأخبرك عندما تجهز.",
      body: "@ada متفق، تابعي.",
    },
    sign_off: { answering: "@theo أصلحت الاختبارات ونجح الـ CI.", body: "@ada ممتاز، انتهى الأمر من جهتي." },
  },
};

for (const [language, moments] of Object.entries(TOGETHER)) {
  for (const [kind, m] of Object.entries(moments) as [Kind, { answering: string; body: string }][]) {
    // A hand-back or a question back is Ada's, to Theo; a courtesy is Theo's, to Ada.
    const fromAda = kind === "handback" || kind === "question_back";
    CASES.push({
      id: `${language}-${kind}`,
      wakes: fromAda,
      from: fromAda ? "ada" : "theo",
      to: fromAda ? theo : ada,
      body: m.body,
      answering: { from: fromAda ? "@theo" : "@ada", text: m.answering },
    });
  }
}

type NoteKind = "ack" | "thanks" | "waits" | "done" | "couldnt" | "question";

/** The sender needs these replies to a note it sent (a result, a "couldn't", a question back), not the rest. */
const MATTERS: Record<NoteKind, boolean> = {
  ack: false,
  thanks: false,
  waits: false,
  done: true,
  couldnt: true,
  question: true,
};

/** What an agent handed another (`note`) and what that agent replied once it finished, in each language. */
const NOTE_REPLIES: Record<string, Record<NoteKind, { note: string; reply: string }>> = {
  pt: {
    ack: { note: "A reunião de amanhã passou para as 15h.", reply: "Combinado, anotado." },
    thanks: { note: "O deploy de staging terminou.", reply: "Obrigado pelo aviso!" },
    waits: {
      note: "A Rita vai te passar a pasta e as notas dela daqui a pouco. Assume os clientes dela.",
      reply: "Ainda não recebi nada da Rita. Assumo os clientes assim que chegar.",
    },
    done: {
      note: "Passa ao Diogo as notas dos teus clientes e confirma que ele consegue abrir.",
      reply: "Feito: mandei ao Diogo um documento com as notas dos 3 clientes e ele confirmou que abriu.",
    },
    couldnt: {
      note: "Exporta do CRM a lista de clientes ativos.",
      reply: "Não consegui: não tenho acesso ao CRM. Quem tem é a Marina.",
    },
    question: {
      note: "Atualiza o contrato da Acme com o novo preço.",
      reply: "Qual preço vale, o de 1.200 ou o de 1.350?",
    },
  },
  en: {
    ack: { note: "Tomorrow's meeting moved to 3pm.", reply: "Got it, noted." },
    thanks: { note: "The staging deploy finished.", reply: "Thanks for the heads-up!" },
    waits: {
      note: "Rita will send you her folder and notes shortly. Take over her clients.",
      reply: "Nothing from Rita yet. I'll take her clients over as soon as it comes.",
    },
    done: {
      note: "Pass your client notes to Diogo and check he can open them.",
      reply: "Done: I sent Diogo a document with the notes on all 3 clients and he confirmed he can open it.",
    },
    couldnt: {
      note: "Export the list of active clients from the CRM.",
      reply: "Couldn't: I have no access to the CRM. Marina has it.",
    },
    question: { note: "Update Acme's contract with the new price.", reply: "Which price, 1,200 or 1,350?" },
  },
  es: {
    ack: { note: "La reunión de mañana pasó a las 15h.", reply: "Entendido, apuntado." },
    thanks: { note: "Terminó el deploy de staging.", reply: "¡Gracias por avisar!" },
    waits: {
      note: "Rita te va a pasar su carpeta y sus notas en un rato. Encárgate de sus clientes.",
      reply: "Todavía no me llegó nada de Rita. Me encargo de sus clientes en cuanto llegue.",
    },
    done: {
      note: "Pásale a Diogo las notas de tus clientes y confirma que puede abrirlas.",
      reply: "Hecho: le mandé a Diogo un documento con las notas de los 3 clientes y confirmó que lo abre.",
    },
    couldnt: {
      note: "Exporta del CRM la lista de clientes activos.",
      reply: "No pude: no tengo acceso al CRM. Lo tiene Marina.",
    },
    question: {
      note: "Actualiza el contrato de Acme con el nuevo precio.",
      reply: "¿Qué precio vale, 1.200 o 1.350?",
    },
  },
  de: {
    ack: { note: "Das Meeting morgen ist auf 15 Uhr verschoben.", reply: "Alles klar, notiert." },
    thanks: { note: "Das Staging-Deploy ist fertig.", reply: "Danke für den Hinweis!" },
    waits: {
      note: "Rita schickt dir gleich ihren Ordner und ihre Notizen. Übernimm ihre Kunden.",
      reply: "Von Rita ist noch nichts da. Ich übernehme ihre Kunden, sobald es kommt.",
    },
    done: {
      note: "Gib Diogo die Notizen zu deinen Kunden und prüf, dass er sie öffnen kann.",
      reply:
        "Erledigt: Ich habe Diogo ein Dokument mit den Notizen zu allen 3 Kunden geschickt, und er hat bestätigt, dass er es öffnen kann.",
    },
    couldnt: {
      note: "Exportier aus dem CRM die Liste der aktiven Kunden.",
      reply: "Ging nicht: Ich habe keinen Zugriff auf das CRM. Marina hat ihn.",
    },
    question: {
      note: "Aktualisier den Vertrag von Acme mit dem neuen Preis.",
      reply: "Welcher Preis gilt, 1.200 oder 1.350?",
    },
  },
  ja: {
    ack: { note: "明日の会議は15時に変更になりました。", reply: "了解です、メモしました。" },
    thanks: { note: "ステージングのデプロイが終わりました。", reply: "お知らせありがとうございます！" },
    waits: {
      note: "リタがまもなくフォルダとメモを渡します。彼女の顧客を引き継いでください。",
      reply: "リタからはまだ何も届いていません。届いたらすぐに顧客を引き継ぎます。",
    },
    done: {
      note: "顧客のメモをディオゴに渡して、彼が開けるか確認してください。",
      reply: "完了しました。3社分のメモをまとめた資料をディオゴに送り、開けることを確認してもらいました。",
    },
    couldnt: {
      note: "CRMからアクティブな顧客のリストをエクスポートしてください。",
      reply: "できませんでした。CRMへのアクセス権がありません。マリナが持っています。",
    },
    question: {
      note: "Acmeの契約を新しい価格で更新してください。",
      reply: "どちらの価格ですか、1,200ですか1,350ですか？",
    },
  },
  ar: {
    ack: { note: "اجتماع الغد تأجل إلى الساعة 3 مساءً.", reply: "تمام، سجلت ذلك." },
    thanks: { note: "انتهى النشر على بيئة الاختبار.", reply: "شكراً على التنبيه!" },
    waits: {
      note: "ستُرسل لك ريتا مجلدها وملاحظاتها بعد قليل. تولَّ عملاءها.",
      reply: "لم يصلني شيء من ريتا بعد. سأتولى عملاءها فور وصوله.",
    },
    done: {
      note: "أعطِ ديوغو ملاحظات عملائك وتأكد أنه يستطيع فتحها.",
      reply: "تم: أرسلت إلى ديوغو مستنداً بملاحظات العملاء الثلاثة وأكد أنه يستطيع فتحه.",
    },
    couldnt: {
      note: "صدّر من نظام CRM قائمة العملاء النشطين.",
      reply: "لم أستطع: ليس لدي وصول إلى نظام CRM. مارينا لديها الوصول.",
    },
    question: { note: "حدّث عقد Acme بالسعر الجديد.", reply: "أي سعر نعتمد، 1200 أم 1350؟" },
  },
};

type DmKind = "later" | "done" | "handedOn";

/**
 * An agent answering another in their DM (ADR 0095): `request`, the question or the work it got, and `reply`, its
 * last message there. A promise it left undone is unkept; a result is done; a part it handed on is no unkept promise
 * (what comes of it goes back with the answer).
 */
const DM_FOLLOW_THROUGH: Record<string, Record<DmKind, { request: string; reply: string }>> = {
  pt: {
    later: { request: "Limpa a fila de jobs de staging.", reply: "Vou limpar a fila mais tarde e te digo como ficou." },
    done: {
      request: "Limpa a fila de jobs de staging.",
      reply: "Feito: limpei a fila, 42 jobs removidos e 0 pendentes.",
    },
    handedOn: {
      request: "Combina com o Diogo quem fica com a Acme e me diz.",
      reply: "Passei ao Diogo decidir quem fica com a Acme. O que ele decidir volta junto com esta resposta.",
    },
  },
  en: {
    later: {
      request: "Clear the staging job queue.",
      reply: "I'll clear the queue later and let you know how it went.",
    },
    done: {
      request: "Clear the staging job queue.",
      reply: "Done: I cleared the queue, 42 jobs removed and 0 pending.",
    },
    handedOn: {
      request: "Agree with Diogo who takes Acme and tell me.",
      reply: "I handed Diogo the call on who takes Acme. What he decides goes back with this answer.",
    },
  },
  es: {
    later: { request: "Limpia la cola de jobs de staging.", reply: "Limpio la cola más tarde y te cuento cómo quedó." },
    done: {
      request: "Limpia la cola de jobs de staging.",
      reply: "Hecho: limpié la cola, 42 jobs eliminados y 0 pendientes.",
    },
    handedOn: {
      request: "Acuerda con Diogo quién se queda con Acme y dime.",
      reply: "Le pasé a Diogo decidir quién se queda con Acme. Lo que decida vuelve con esta respuesta.",
    },
  },
  de: {
    later: {
      request: "Leer die Staging-Job-Queue.",
      reply: "Ich leere die Queue später und sage dir dann Bescheid.",
    },
    done: { request: "Leer die Staging-Job-Queue.", reply: "Erledigt: Queue geleert, 42 Jobs entfernt, 0 offen." },
    handedOn: {
      request: "Klär mit Diogo, wer Acme übernimmt, und sag mir Bescheid.",
      reply: "Ich habe Diogo die Entscheidung zu Acme übergeben. Was er entscheidet, geht mit dieser Antwort zurück.",
    },
  },
  ja: {
    later: {
      request: "ステージングのジョブキューを空にしてください。",
      reply: "あとでキューを空にして、結果をお知らせします。",
    },
    done: {
      request: "ステージングのジョブキューを空にしてください。",
      reply: "完了しました。キューを空にし、42件のジョブを削除しました。保留は0件です。",
    },
    handedOn: {
      request: "Acmeを誰が担当するかディオゴと決めて教えてください。",
      reply: "Acmeの担当はディオゴに決めてもらうよう渡しました。彼の決定はこの回答と一緒に戻ります。",
    },
  },
  ar: {
    later: { request: "أفرغ طابور المهام في بيئة الاختبار.", reply: "سأفرغ الطابور لاحقاً وأخبرك بالنتيجة." },
    done: {
      request: "أفرغ طابور المهام في بيئة الاختبار.",
      reply: "تم: أفرغت الطابور، وحُذفت 42 مهمة، ولا يوجد شيء معلق.",
    },
    handedOn: {
      request: "اتفق مع ديوغو على من سيتولى Acme وأخبرني.",
      reply: "أحلت إلى ديوغو قرار من سيتولى Acme. ما يقرره سيعود مع هذا الرد.",
    },
  },
};

const ORG = "00000000-0000-0000-0000-000000000000";
const which = process.argv.includes("--judge") ? process.argv[process.argv.indexOf("--judge") + 1] : "jev";
const noUsage = { recordExternalUsage: async () => null };

let judge: Judge;
if (which === "jev") {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is missing (or run with --judge llm)");
  judge = createJevJudge({ key: apiKey, gateway: noUsage, timeoutMs: 10_000 });
} else {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
  const provider = createAnthropicProvider();
  const model = process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5";
  judge = createLlmJudge({
    gateway: {
      complete: (async (call: Parameters<typeof provider.stream>[0]) =>
        provider.stream(call, { apiKey, onDelta: () => {} })) as never,
    },
    resolveModel: async () => model,
  });
}

let right = 0;
const rows = await Promise.all(
  CASES.map(async (c) => {
    const scores = await mentionNeedsNothing(judge, {
      orgId: ORG,
      body: c.body,
      author: `@${c.from}`,
      answering: c.answering ?? null,
      targets: [{ agentId: c.to.handle, handle: c.to.handle, name: c.to.name, role: c.to.role }],
    });
    const nothing = scores.get(c.to.handle) ?? 0;
    return { c, nothing, ok: 1 - nothing >= MENTION_WAKE_THRESHOLD === c.wakes };
  }),
);
for (const { c, nothing, ok } of rows) {
  if (ok) right++;
  console.log(`${ok ? "PASS" : "FAIL"}  nothing ${nothing.toFixed(2)}  ${c.wakes ? "wakes " : "asleep"}  ${c.id}`);
}

const call = { orgId: ORG, agentId: ORG, runId: ORG };
const notes = await Promise.all(
  Object.entries(NOTE_REPLIES).flatMap(([language, moments]) =>
    (Object.entries(moments) as [NoteKind, { note: string; reply: string }][]).map(async ([kind, m]) => {
      const matters = await noteReplyMatters(judge, { ...call, note: m.note, reply: m.reply });
      return { id: `note-${language}-${kind}`, want: MATTERS[kind], matters };
    }),
  ),
);
for (const n of notes) {
  if (n.matters === n.want) right++;
  console.log(
    `${n.matters === n.want ? "PASS" : "FAIL"}  ${n.matters ? "goes back" : "nothing  "}  ${n.want ? "result   " : "courtesy "}  ${n.id}`,
  );
}
const dms = await Promise.all(
  Object.entries(DM_FOLLOW_THROUGH).flatMap(([language, moments]) =>
    (Object.entries(moments) as [DmKind, { request: string; reply: string }][]).map(async ([kind, m]) => {
      const verdict = await followThroughVerdict(judge, { ...call, request: m.request, reply: m.reply });
      const ok = kind === "later" ? verdict === "unkept" : kind === "done" ? verdict === "done" : verdict !== "unkept";
      return { id: `dm-${language}-${kind}`, kind, verdict, ok };
    }),
  ),
);
for (const d of dms) {
  if (d.ok) right++;
  console.log(`${d.ok ? "PASS" : "FAIL"}  ${d.verdict.padEnd(7)}  ${d.kind.padEnd(9)}  ${d.id}`);
}
const total = CASES.length + notes.length + dms.length;
console.log(
  `\n${right}/${total} right (${which}; mentions asleep only at "nothing" ≥ ${(1 - MENTION_WAKE_THRESHOLD).toFixed(2)}, note replies at 0.5, unkept promises at 0.6)`,
);
process.exit(right === total ? 0 : 1);
