import type { Step } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in ko: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("ko", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 * Korean has no plural forms: `n === 1` only picks the wording English uses for a single item. A name is followed
 * by a particle that reads right after any final sound (에, 에서, 의, 님이) or by both forms (을(를), 이(가), (으)로).
 */
export const words: EmailWords = {
  sentBy: (host) =>
    host
      ? ["이 메일은 ", { nobr: host }, "의 agentes.chat 서버에서 보냈어요."]
      : "이 메일은 agentes.chat에서 보냈어요.",
  fallback: "버튼이 작동하지 않나요? 이 주소를 브라우저에 복사해 붙여넣으세요.",
  role: { owner: "소유자", member: "멤버" },
  anAgent: "에이전트",
  someone: "누군가",
  verify: {
    subject: "agentes.chat 이메일을 인증해 주세요",
    preheader: "클릭 한 번이면 이 주소가 인증돼요. 링크는 1시간 동안 유효해요.",
    headline: "이메일을 인증해 주세요",
    body: "이제 한 단계만 남았어요. 이 주소가 본인의 것인지 확인해 주세요.",
    button: "이메일 인증",
    small: "링크는 1시간 동안 유효해요. 가입한 적이 없다면 이 메일은 무시하세요.",
    why: "이 주소로 agentes.chat에 가입해서 이 메일을 보내 드렸어요.",
  },
  reset: {
    subject: "agentes.chat 비밀번호를 재설정하세요",
    preheader: "새 비밀번호를 정하세요. 링크는 1시간 동안 유효해요.",
    headline: "새 비밀번호 정하기",
    body: "이 주소의 비밀번호를 재설정해 달라는 요청을 받았어요.",
    button: "새 비밀번호 정하기",
    note: "요청한 적이 없나요? 이 메일은 무시하세요. 비밀번호는 그대로예요.",
    small: "링크는 1시간 동안 유효해요.",
    why: "누군가 agentes.chat에서 이 주소의 비밀번호 재설정을 요청해서 이 메일을 보내 드렸어요.",
  },
  invitation: {
    subject: "agentes.chat 워크스페이스에 초대받았어요",
    preheader: "7일 안에 이 이메일 주소로 수락하세요.",
    headline: "워크스페이스에 초대받았어요",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} 님이 `, { b: org }, `에 ${role}로 초대했어요.`]
        : [{ b: org }, `에 ${role}로 초대받았어요.`],
    what: "agentes.chat은 사람과 AI 에이전트가 함께 일하는 곳이에요.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "보낸 메시지: " }, `“${note}”`],
    button: "초대 수락",
    small: "초대는 7일 동안 유효해요. 이 이메일 주소로 수락하세요.",
    why: (org) =>
      `${org}의 누군가 이 주소를 초대해서 이 메일을 보내 드렸어요. 모르는 사람이라면 무시하세요. 수락하기 전에는 아무 일도 일어나지 않아요.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} 님이 agentes.chat의 개인 워크스페이스에 초대했어요.`]
          : "agentes.chat의 개인 워크스페이스에 초대받았어요.",
      why: () =>
        "누군가 이 주소를 개인 워크스페이스에 초대해서 이 메일을 보내 드렸어요. 모르는 사람이라면 무시하세요. 수락하기 전에는 아무 일도 일어나지 않아요.",
    },
  },
  inviteRequest: {
    subject: "누군가 새 초대를 요청했어요",
    preheader: "초대가 만료됐어요. 멤버 페이지에서 새 초대를 보낼 수 있어요.",
    headline: "누군가 새 초대를 요청했어요",
    body: (email, org) =>
      email
        ? [{ b: email }, " 님이 ", { b: org }, "의 만료된 초대를 열고 새 초대를 요청했어요."]
        : [{ b: org }, "의 만료된 초대 링크를 가진 사람이 새 초대를 요청했어요."],
    next: "아는 사람이라면 멤버 페이지에서 새 초대를 보내세요. 아니라면 아무것도 하지 않아도 돼요.",
    button: "멤버 열기",
    why: (org) => `이 초대를 만들었거나 ${org}의 멤버를 관리하고 있어서 이 메일을 보내 드렸어요.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " 님이 내 워크스페이스의 만료된 초대를 열고 새 초대를 요청했어요."]
          : "내 워크스페이스의 만료된 초대 링크를 가진 사람이 새 초대를 요청했어요.",
      why: () => "이 초대를 만들었거나 내 워크스페이스에 누가 있는지 관리하고 있어서 이 메일을 보내 드렸어요.",
    },
  },
  calendar: {
    subject: "일정에 초대받았어요",
    preheader: (when) => `${when}. 캘린더에서 확인하세요.`,
    headline: "일정에 초대받았어요",
    facts: { event: "일정", when: "일시", org: "워크스페이스", by: "초대한 사람" },
    someone: "누군가",
    button: "일정 보기",
    why: (org) => `${org}의 누군가 일정에 초대해서 이 메일을 보내 드렸어요.`,
    personal: {
      why: () => "내 워크스페이스의 누군가 일정에 초대해서 이 메일을 보내 드렸어요.",
    },
  },
  waitlist: {
    subject: "agentes.chat 대기자 명단 등록을 확인해 주세요",
    preheader: "클릭 한 번이면 자리가 확보돼요.",
    headline: "대기자 명단 등록 확인",
    body: (email) =>
      email
        ? [{ b: email }, " 주소를 agentes.chat 대기자 명단에 올려 달라는 요청을 받았어요."]
        : "이 주소를 agentes.chat 대기자 명단에 올려 달라는 요청을 받았어요.",
    approve: "여기서는 중요한 일은 사람이 승인해야만 일어나요. 이 요청도 마찬가지예요.",
    button: "이메일 확인",
    small:
      "링크는 48시간 동안 유효해요. 본인이 아닌가요? 이 메일은 무시하세요. 클릭하지 않으면 명단에 올라가지 않아요.",
    why: "이 주소가 agentes.chat 대기자 명단에 입력되어 이 메일을 보내 드렸어요.",
  },
  earlyAccess: {
    subject: "agentes.chat 초대가 도착했어요",
    preheader: (days) => `${days}일 안에 이 이메일 주소로 계정을 만드세요.`,
    headline: "이용할 준비가 됐어요",
    body: (email) => [{ b: email }, " 주소로 이제 agentes.chat에서 계정과 워크스페이스를 만들 수 있어요."],
    what: "agentes.chat은 사람과 AI 에이전트가 함께 일하는 곳이에요.",
    button: "계정 만들기",
    small: (days) =>
      `링크는 ${days}일 동안 이 주소에서만 유효해요. 비밀번호로 가입하거나, 같은 주소의 Google, GitHub, Apple 계정으로 가입하세요.`,
    why: "이 주소가 agentes.chat 대기자 명단에 있거나 agentes.chat에 초대받아서 이 메일을 보내 드렸어요. 가입하기 전에는 아무 일도 일어나지 않아요.",
  },
  earlyAccessAllowed: {
    subject: "이제 나만의 워크스페이스를 만들 수 있어요",
    preheader: "지금 쓰는 계정으로 로그인해서 만들어 보세요.",
    headline: "나만의 워크스페이스 만들기",
    body: (email) => [
      "이제 지금 쓰는 계정 ",
      { b: email },
      "(으)로 agentes.chat에서 나만의 워크스페이스를 만들 수 있어요.",
    ],
    button: "워크스페이스 만들기",
    why: "이 계정에 agentes.chat 얼리 액세스가 열려서 이 메일을 보내 드렸어요.",
  },
  budget: {
    subject: {
      warning: "에이전트가 월 예산의 80%를 넘었어요",
      exhausted: "에이전트가 멈췄어요: 월 예산 도달",
    },
    preheader: {
      warning: "100%가 되면 다음 달이 되거나 한도가 오를 때까지 멈춰요.",
      exhausted: "다음 달이 되거나 한도가 오를 때까지 답하지 않아요.",
    },
    headline: { warning: "에이전트가 예산의 80%를 넘었어요", exhausted: "에이전트가 예산을 다 썼어요" },
    used: (pct, org) => `이번 달 예산의 ${pct} 사용 · ${org}`,
    warning: "100%가 되면 멈추고 채널에 알려요. 관리자는 에이전트 페이지에서 한도를 바꿀 수 있어요.",
    exhausted: "다음 달이 되거나 관리자가 한도를 올릴 때까지 답하지 않아요.",
    button: "예산 보기",
    why: (org) =>
      `이 에이전트의 소유자이거나 ${org}의 관리자여서 이 메일을 보내 드렸어요. 80%와 100%에서 각각 한 달에 한 번 보내요.`,
    personal: {
      warning: "100%가 되면 멈추고 알려 드려요. 한도는 에이전트 페이지에서 바꿀 수 있어요.",
      exhausted: "다음 달이 되거나 에이전트 페이지에서 한도를 올릴 때까지 답하지 않아요.",
      why: () => "이 에이전트가 내 에이전트여서 이 메일을 보내 드렸어요. 80%와 100%에서 각각 한 달에 한 번 보내요.",
    },
  },
  digest: {
    subject: (n) => (n === 1 ? "승인을 기다리는 요청이 있어요" : `승인을 기다리는 요청이 ${n}개 있어요`),
    preheader: "요청은 24시간 후에 만료되고, 결정하기 전에는 아무것도 실행되지 않아요.",
    headline: (n) => (n === 1 ? "확인을 기다리는 요청이 있어요" : `확인을 기다리는 요청이 ${n}개 있어요`),
    body: (n, org) => [
      { b: org },
      n === 1
        ? "에서 에이전트가 사람만 승인할 수 있는 일을 요청했어요."
        : "에서 에이전트들이 사람만 승인할 수 있는 일을 요청했어요.",
    ],
    age: (h) => `${h} 시간 전`,
    more: (k) => `그 밖에 ${k}개가 더\u00a0있어요.`,
    button: (n) => (n === 1 ? "요청 검토" : "승인 열기"),
    why: (org, hours) =>
      `${org}에서 이 요청들을 승인할 수 있어서 이 메일을 보내 드렸어요.${hours ? ` 요청이 ${hours}시간 넘게 기다리면 요청마다 한 번 보내요.` : ""}`,
    personal: {
      body: () => "내 에이전트가 승인이 필요한 일을 요청했어요.",
      why: (_org, hours) =>
        `이 요청들을 승인할 수 있어서 이 메일을 보내 드렸어요.${hours ? ` 요청이 ${hours}시간 넘게 기다리면 요청마다 한 번 보내요.` : ""}`,
    },
  },
  ready: {
    subject: "에이전트의 컴퓨터가 준비됐어요",
    preheader: {
      ai: "다음 단계: AI를 연결해서 에이전트가 생각할 수 있게 하세요.",
      task: "다음 단계: 에이전트에게 첫 작업을 맡기세요.",
      create: "다음 단계: 첫 에이전트를 만드세요.",
    },
    headline: "에이전트의 컴퓨터가 준비됐어요",
    computer: "에이전트의 컴퓨터",
    body: (org) => [
      "기다려 주셔서 감사해요. ",
      { b: org },
      "의 컴퓨터가 켜졌고 설정도 끝났어요. 에이전트마다 전용 사용자가 있어요. 밤낮으로 켜져 있어서 에이전트가 언제든 일할 수 있어요.",
    ],
    facts: { cpus: "CPU", memory: "메모리", disk: "디스크" },
    next: "다음 단계",
    steps: {
      ai: [
        "AI를 연결하세요.",
        "Claude나 ChatGPT 요금제, 다른 AI의 코딩 요금제, 또는 API 키로 로그인하세요. 에이전트는 이걸로 생각해요.",
      ] as Step,
      task: ["첫 작업을 맡기세요.", "#general에서 @로 에이전트를 부르고 필요한 걸 말하세요."] as Step,
      watch: [
        "일하는 모습을 지켜보세요.",
        "에이전트 페이지에서 열기를 누르면 컴퓨터 화면을 실시간으로 볼 수 있어요. 언제든 직접 조작하고, 끝나면 다시 넘겨주세요.",
      ] as Step,
      create: ["에이전트를 만드세요.", "처음부터 이 컴퓨터에서 일해요."] as Step,
    },
    button: { ai: "AI 연결", task: "첫 작업 맡기기", create: "에이전트 만들기" },
    why: (org) =>
      `agentes.chat에서 ${org}의 소유자여서 이 메일을 보내 드렸어요. 이 컴퓨터에 관한 메일은 이것 하나뿐이에요.`,
    personal: {
      body: () =>
        "기다려 주셔서 감사해요. 내 에이전트의 컴퓨터가 켜졌고 설정도 끝났어요. 에이전트마다 전용 사용자가 있어요. 밤낮으로 켜져 있어서 에이전트가 언제든 일할 수 있어요.",
      steps: {
        task: ["첫 작업을 맡기세요.", "내 에이전트 중 하나와 대화를 열고 필요한 걸 말하세요."] as Step,
      },
      why: () =>
        "agentes.chat의 이 워크스페이스가 내 것이어서 이 메일을 보내 드렸어요. 이 컴퓨터에 관한 메일은 이것 하나뿐이에요.",
    },
  },
  joinRequest: {
    subject: "누군가 워크스페이스에 참여하고 싶어 해요",
    preheader: "멤버 페이지에서 승인하거나 거절하세요. 답하기 전에는 아무 일도 일어나지 않아요.",
    headline: "참여 요청이 기다리고 있어요",
    body: (org) => [{ b: org }, "의 초대 링크를 열고 참여를 요청했어요."],
    note: "아는 사람만 승인하세요. 페이지에서 다른 역할을 고르지 않으면 멤버로 참여해요.",
    approve: "승인",
    deny: "거절",
    more: "기다리는 요청은 모두 멤버 페이지에 있어요.",
    why: (org) => `${org}의 소유자 또는 관리자여서 이 메일을 보내 드렸어요. 최대 1시간에 한 번 보내요.`,
    personal: {
      body: () => "내 워크스페이스의 초대 링크를 열고 참여를 요청했어요.",
      why: () =>
        "내 워크스페이스에 누가 참여하는지 관리하고 있어서 이 메일을 보내 드렸어요. 최대 1시간에 한 번 보내요.",
    },
  },
  joinAnswer: {
    someone: "누군가",
    joined: {
      subject: "참여 요청이 승인됐어요",
      preheader: "참여했어요. 워크스페이스를 열고 시작하세요.",
      headline: "참여했어요",
      body: (who, org, role) => [`${who} 님이 요청을 승인했어요. `, { b: org }, `에 ${role}로 참여했어요.`],
      button: "워크스페이스 열기",
    },
    invited: {
      subject: "참여 요청이 승인됐어요",
      preheader: "한 단계만 남았어요. 7일 안에 초대를 수락하세요.",
      headline: "승인 완료: 한 단계만 남았어요",
      body: (who, org) => [`${who} 님이 `, { b: org }, " 참여 요청을 승인했어요."],
      next: "7일 안에 이 이메일 주소로 초대를 수락하세요.",
      button: "초대 수락",
    },
    denied: {
      subject: "참여 요청이 승인되지 않았어요",
      preheader: "워크스페이스의 누군가 요청을 확인했지만 승인하지 않았어요.",
      headline: "요청이 승인되지 않았어요",
      body: (org) => [{ b: org }, "의 누군가 요청을 확인했지만 승인하지 않았어요."],
      reason: (reason) => [{ b: "남긴 메모: " }, `“${reason}”`],
      small: "착오라고 생각되면 그곳의 누군가에게 이메일로 초대해 달라고 하세요.",
    },
    why: (org) => `이 주소로 agentes.chat의 ${org}에 참여를 요청해서 이 메일을 보내 드렸어요.`,
    personal: {
      joined: { body: (who) => `${who} 님이 요청을 승인했어요. 이제 워크스페이스에 참여했어요.` },
      invited: { body: (who) => `${who} 님이 워크스페이스 참여 요청을 승인했어요.` },
      denied: {
        preheader: "요청을 확인했지만 승인하지 않았어요.",
        body: () => "요청을 받은 사람이 확인했지만 승인하지 않았어요.",
        small: "착오라고 생각되면 그 사람에게 이메일로 초대해 달라고 하세요.",
      },
      why: () => "이 주소로 agentes.chat의 개인 워크스페이스에 참여를 요청해서 이 메일을 보내 드렸어요.",
    },
  },
  joinCode: {
    subject: (code) => `agentes.chat 인증 코드: ${code}`,
    preheader: "페이지에 입력하면 참여를 요청할 수 있어요. 10분 동안 유효해요.",
    headline: "인증 코드",
    body: (org) => ["이 코드를 페이지에 입력하면 ", { b: org }, "에 참여를 요청할 수 있어요."],
    small: ["10분 동안 유효해요. 요청한 적이 없다면 ", { nobr: "이 메일은 무시하세요." }],
    why: (org) => `누군가 agentes.chat의 ${org}에 참여하려고 이 주소를 입력해서 이 메일을 보내 드렸어요.`,
    personal: {
      body: () => "이 코드를 페이지에 입력하면 이 워크스페이스에 참여를 요청할 수 있어요.",
      why: () => "누군가 agentes.chat의 개인 워크스페이스에 참여하려고 이 주소를 입력해서 이 메일을 보내 드렸어요.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `워크스페이스 삭제 코드: ${code}`,
    subjectAccount: (code) => `계정 전체 삭제 코드: ${code}`,
    preheader: "agentes.chat에 입력해서 확인하세요. 10분 동안 유효해요.",
    headline: "인증 코드",
    workspace: (org) => [
      "이 코드를 입력하면 워크스페이스 ",
      { b: org },
      "이(가) 삭제돼요. 모두에게 즉시 읽기 전용이 되고, 7일 후에 완전히 삭제돼요.",
    ],
    account: (email) => [
      "이 코드를 입력하면 계정 ",
      { b: email },
      " 전체가 삭제돼요. 워크스페이스 하나만 삭제되는 게 아니에요. 즉시 모든 기기에서 로그아웃되고 7일 후에 완전히 삭제돼요. 나만 있는 워크스페이스도 함께 닫혀요.",
    ],
    support: (address) => [
      "10분 동안 유효하고, 이 코드 없이는 아무것도 삭제되지 않아요. 본인이 아니라면 공유하지 말고 ",
      { mail: address },
      "(으)로 연락해 주세요.",
    ],
    noSupport:
      "10분 동안 유효하고, 이 코드 없이는 아무것도 삭제되지 않아요. 본인이 아니라면 공유하지 말고 이 서버 운영자에게 알려 주세요.",
    whyWorkspace: (org) => `내 계정에서 agentes.chat의 ${org} 삭제를 요청해서 이 메일을 보내 드렸어요.`,
    whyAccount: "내 계정에서 agentes.chat 계정 삭제를 요청해서 이 메일을 보내 드렸어요.",
    personal: {
      workspace: (org) => [
        "이 코드를 입력하면 내 워크스페이스 ",
        { b: org },
        "이(가) 삭제돼요. 즉시 읽기 전용이 되고, 7일 후에 완전히 삭제돼요.",
      ],
    },
  },
  deleting: {
    subject: (day) => `참여 중인 워크스페이스가 ${day}에 삭제돼요`,
    preheader: "지금은 읽기 전용이에요. 그때까지는 소유자가 복원할 수 있어요.",
    headline: "워크스페이스가 삭제되고 있어요",
    body: (by, org, day, time) => [
      { b: by },
      " 님이 워크스페이스 ",
      { b: org },
      `을(를) 삭제했어요. 지금은 읽기 전용이고, ${day} ${time}에 완전히 삭제돼요.`,
    ],
    owner: "마음이 바뀌었나요? 그 전에 복원하세요.",
    button: "워크스페이스 복원",
    member: "착오라면 소유자에게 복원을 요청하세요.",
    why: (org) => `agentes.chat의 ${org}에 참여 중이어서 이 메일을 보내 드렸어요.`,
    personal: {
      member: "착오라면 삭제한 사람에게 복원을 요청하세요.",
      why: () => "agentes.chat의 이 워크스페이스에 참여 중이어서 이 메일을 보내 드렸어요.",
    },
  },
  restored: {
    subject: "참여 중인 워크스페이스가 돌아왔어요",
    preheader: "소유자가 복원했어요. 다시 사용할 수 있어요.",
    headline: "워크스페이스가 돌아왔어요",
    body: (by, org) => [{ b: by }, " 님이 ", { b: org }, "을(를) 복원했어요. 다시 사용할 수 있어요."],
    button: "워크스페이스 열기",
    why: (org) => `agentes.chat의 ${org}에 참여 중이어서 이 메일을 보내 드렸어요.`,
    personal: {
      why: () => "agentes.chat의 이 워크스페이스에 참여 중이어서 이 메일을 보내 드렸어요.",
    },
  },
  appConnected: {
    subject: "agentes.chat 계정에 앱이 연결됐어요",
    preheader: "한 워크스페이스에서 나 대신 에이전트의 작업을 읽고 보낼 수 있어요.",
    headline: "앱이 연결됐어요",
    body: (app, org) => [{ b: app }, "에서 이제 ", { b: org }, "의 내 계정에 접근할 수 있어요."],
    note: "직접 연결하지 않았나요? 지금 연결을 끊고 비밀번호를 바꾸세요.",
    button: "연결된 앱 보기",
    why: (org) => `agentes.chat의 ${org}에서 내 계정에 앱이 연결되어 이 메일을 보내 드렸어요.`,
    personal: {
      body: (app) => [{ b: app }, "에서 이제 개인 워크스페이스의 내 계정에 접근할 수 있어요."],
      why: () => "agentes.chat 개인 워크스페이스에서 내 계정에 앱이 연결되어 이 메일을 보내 드렸어요.",
    },
  },
  accountDeleting: {
    subject: (day) => `agentes.chat 계정이 ${day}에 삭제돼요`,
    preheader: "마음을 바꿀 수 있는 시간은 7일이에요.",
    headline: "계정을 삭제하고 있어요",
    body: (email, day, time) => [
      "계정 ",
      { b: email },
      ` 을(를) ${day} ${time}에 삭제해요. 모든 기기에서 로그아웃됐고, 돌아올 때까지 여기서 아무도 연락할 수 없어요.`,
    ],
    closes: (_count, names) => ["나만 있던 워크스페이스는 지금 닫혔고 같은 날 삭제돼요: ", ...names, "."],
    undo: "마음이 바뀌었나요? 그 전에 로그인해서 복원을 누르세요.",
    button: "로그인해서 복원",
    why: "이 주소로 agentes.chat 계정이 있어서 이 메일을 보내 드렸어요.",
  },
  accountDeleted: {
    subject: "agentes.chat 계정이 삭제됐어요",
    preheader: "모든 기기에서 로그아웃됐고 다시 로그인할 수 없어요.",
    headline: "계정이 삭제됐어요",
    body: (email) => ["계정 ", { b: email }, "을(를) 삭제했어요."],
    closes: (_count, day, names) => [`나만 있던 워크스페이스는 닫혔고 ${day}에 완전히 삭제돼요: `, ...names, "."],
    support: (address) => ["본인이 아니라면 ", { mail: address }, "(으)로 연락해 주세요."],
    noSupport: "본인이 아니라면 이 서버 운영자에게 알려 주세요.",
    why: "이 주소로 agentes.chat 계정이 있어서 이 메일을 보내 드렸어요.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `${day} 에이전트: 멈춤 ${stalls}건, 헛실행 ${noise}건`,
    preheader: "에이전트가 멈춘 곳과 괜히 움직인 곳을 지난 7일과 비교해요.",
    headline: (day) => `${day} 멈춤과 헛실행`,
    body: "이 서버의 활성 워크스페이스 전체, UTC 기준 하루. 이름과 건수만 담았어요.",
    stalls: "멈춤",
    noise: "헛실행",
    metric: {
      mentionNoRun: "아무도 깨우지 못한 멘션",
      readOnly: "읽기만 할 수 있었던 실행",
      promiseUnkept: "할 일을 남긴 채 끝남",
      promiseIgnored: "알림 후에도 남은 일",
      handoffUnanswered: "30분 안에 답이 없던 인계",
      limitStops: "한도로 멈춤",
      personUnanswered: "10분 안에 답을 못 받은 사람",
      taskStartFailed: "시작부터 실패한 작업",
      noiseRuns: "괜한 실행",
      quietRuns: "아무 말 없이 끝남",
      ackReplies: "감사나 확인 인사에 답함",
      idleWakes: "할 일 없이 깨어남",
      noiseTokens: "사용한 토큰",
      noiseCostNanoUsd: "든 비용",
    },
    value: (today, average) => `${today} · 7일 평균 ${average}`,
    topStalls: "멈춤이 가장 많은 곳",
    topNoise: "괜한 실행이 가장 많은 곳과 그 비용",
    none: "워크스페이스가 없어요.",
    table: (day) => `전체 표: bun run report:autonomy --day ${day}`,
    why: "이 주소가 이 서버의 OPS_REPORT_EMAIL에 있어서 이 메일을 보내 드렸어요. 하루에 한 번 보내요.",
  },
  planOpened: {
    subject: (plan) => `내 ${plan} 플랜으로 더 많은 사람이 내 에이전트와 대화할 수 있어요`,
    preheader: (plan) => `그 대화에는 내 ${plan} 플랜과 그 한도가 쓰여요.`,
    headline: "더 많은 사람이 내 에이전트와 대화할 수 있어요",
    body: (by, agent, plan) => [
      { b: by },
      " 님이 ",
      { b: agent },
      `와 대화할 수 있는 사람을 늘렸어요. 그 대화에는 내 ${plan} 플랜과 그 한도가 쓰여요.`,
    ],
    agent: "에이전트",
    by: "변경한 사람",
    was: "이전",
    now: "지금",
    everyone: "워크스페이스의 모든 사람",
    onlyYou: "나만",
    you: "나",
    note: "되돌리려면 에이전트 페이지에서 대화할 수 있는 사람을 바꾸세요.",
    button: "대화할 수 있는 사람 보기",
    why: (org) =>
      `${org}에 있는 내 에이전트가 내 플랜으로 생각하고, 다른 사람이 그 에이전트와 대화할 수 있는 사람을 바꿔서 이 메일을 보내 드렸어요.`,
    personal: {
      why: () =>
        "내 에이전트가 내 플랜으로 생각하고, 다른 사람이 그 에이전트와 대화할 수 있는 사람을 바꿔서 이 메일을 보내 드렸어요.",
    },
  },
  planLent: {
    subject: (plan) => `내 ${plan} 플랜이 이제 다른 에이전트를 위해 생각해요`,
    preheader: (plan) => `그 대화에는 내 ${plan} 플랜과 그 한도가 쓰여요. 되돌려 받을 수 있어요.`,
    headline: "누군가 내 플랜을 에이전트에 연결했어요",
    body: (by, agent, plan) => [
      { b: by },
      ` 님이 내 ${plan} 플랜을 에이전트 `,
      { b: agent },
      "에 연결했어요. 그 대화에는 내 플랜과 그 한도가 쓰여요.",
    ],
    agent: "에이전트",
    by: "연결한 사람",
    plan: "플랜",
    note: "알림에서 한 번의 클릭으로 되돌려 받으면 에이전트가 더 이상 내 플랜으로 생각하지 않아요.",
    button: "알림 열기",
    why: (org) => `${org}에서 누군가 내 플랜을 에이전트에 연결해서 이 이메일을 받았어요.`,
    personal: {
      why: () => "내 워크스페이스에서 누군가 내 플랜을 에이전트에 연결해서 이 메일을 보내 드렸어요.",
    },
  },
  planWaiting: {
    subject: "팀이 기다리고 있어요",
    preheader: "워크스페이스가 준비됐어요. 시작하려면 agentes.chat 요금제가 필요해요.",
    headline: "팀이 기다리고 있어요",
    body: (agents, channels, routines) => {
      const a = `에이전트 ${agents}개`;
      const c = `채널 ${channels}개`;
      const r = `루틴 ${routines}개`;
      return routines > 0
        ? `${a}, ${c}, ${r}가 준비됐어요. 시작하려면 agentes.chat 요금제가 필요해요.`
        : `${a}, ${c}가 준비됐어요. 시작하려면 agentes.chat 요금제가 필요해요.`;
    },
    button: "agentes.chat 요금제 보기",
    why: (org) => `agentes.chat에서 ${org}을(를) 운영하고 있어서 이 메일을 보내드려요. 이런 알림은 두 번만 보내요.`,
    personal: {
      subject: "내 에이전트가 기다리고 있어요",
      headline: "내 에이전트가 기다리고 있어요",
      body: (agents, _channels, routines) => {
        const a = `에이전트 ${agents}개`;
        const r = `루틴 ${routines}개`;
        return `${routines > 0 ? `${a}와 ${r}` : a}가 준비됐어요. 이제 agentes.chat 요금제만 있으면 돼요.`;
      },
      why: () => "agentes.chat의 이 워크스페이스가 내 것이어서 이 메일을 보내 드렸어요. 이런 알림은 두 번만 보내요.",
    },
  },
};
