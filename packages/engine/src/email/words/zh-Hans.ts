import type { EmailWords } from "./index";

/**
 * The emails in zh-Hans: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("zh-Hans", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 * Chinese has no plural forms: `n === 1` only picks the wording English uses for a single item.
 */
export const words: EmailWords = {
  sentBy: (host) => (host ? ["由 ", { nobr: host }, " 上的 agentes.chat 服务器发送。"] : "由 agentes.chat 发送。"),
  fallback: "按钮无法使用？把这个地址复制到浏览器中打开：",
  role: { owner: "所有者", member: "成员" },
  anAgent: "一个智能体",
  someone: "有人",
  verify: {
    subject: "确认你在 agentes.chat 的邮箱",
    preheader: "点一下即可确认这个地址。链接 1 小时内有效。",
    headline: "确认你的邮箱",
    body: "只差一步：确认这个地址是你的。",
    button: "确认邮箱",
    small: "链接 1 小时内有效。如果你没有注册，忽略这封邮件即可。",
    why: "你收到这封邮件，是因为有人用这个地址注册了 agentes.chat。",
  },
  reset: {
    subject: "重置你的 agentes.chat 密码",
    preheader: "设置一个新密码。链接 1 小时内有效。",
    headline: "设置新密码",
    body: "我们收到了重置这个地址密码的请求。",
    button: "设置新密码",
    note: "不是你本人操作？忽略这封邮件即可，你的密码不会改变。",
    small: "链接 1 小时内有效。",
    why: "你收到这封邮件，是因为有人在 agentes.chat 上请求重置这个地址的密码。",
  },
  invitation: {
    subject: "你受邀加入 agentes.chat 上的一个工作区",
    preheader: "请在 7 天内用这个邮箱地址接受邀请。",
    headline: "你受邀加入一个工作区",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} 邀请你以${role}身份加入 `, { b: org }, "。"]
        : [`你受邀以${role}身份加入 `, { b: org }, "。"],
    what: "agentes.chat 是成员和 AI 智能体一起工作的地方。",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}：` : "附言：" }, `“${note}”`],
    button: "接受邀请",
    small: "邀请 7 天内有效。请用这个邮箱地址接受。",
    why: (org) =>
      `你收到这封邮件，是因为 ${org} 的成员邀请了这个地址。如果你不认识对方，忽略即可。在你接受之前，什么都不会发生。`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} 邀请你加入 agentes.chat 上的个人工作区。`]
          : "你受邀加入 agentes.chat 上的一个个人工作区。",
      why: () =>
        "你收到这封邮件，是因为有人邀请这个地址加入个人工作区。如果你不认识对方，忽略即可。在你接受之前，什么都不会发生。",
    },
  },
  inviteRequest: {
    subject: "有人请求新的邀请",
    preheader: "对方的邀请已过期。你可以在“成员”中发送新的邀请。",
    headline: "有人请求新的邀请",
    body: (email, org) =>
      email
        ? [{ b: email }, " 打开了加入 ", { b: org }, " 的过期邀请，并请求一个新的。"]
        : ["有人用过期的邀请链接尝试加入 ", { b: org }, "，并请求一个新的。"],
    next: "如果你认识对方，请在“成员”中发送新的邀请。如果不认识，无需任何操作。",
    button: "打开成员",
    why: (org) => `你收到这封邮件，是因为你创建了这个邀请，或者负责管理 ${org} 的成员。`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " 打开了加入你的工作区的过期邀请，并请求一个新的。"]
          : "有人用过期的邀请链接尝试加入你的工作区，并请求一个新的。",
      why: () => "你收到这封邮件，是因为你创建了这个邀请，或者负责管理谁在你的工作区里。",
    },
  },
  calendar: {
    subject: "你受邀参加一个活动",
    preheader: (when) => `${when}。在日历中查看。`,
    headline: "你受邀参加一个活动",
    facts: { event: "活动", when: "时间", org: "工作区", by: "邀请人" },
    someone: "有人",
    button: "查看活动",
    why: (org) => `你收到这封邮件，是因为 ${org} 的成员邀请你参加一个活动。`,
    personal: {
      why: () => "你收到这封邮件，是因为你的工作区里有人邀请你参加一个活动。",
    },
  },
  waitlist: {
    subject: "确认你在 agentes.chat 候补名单上的位置",
    preheader: "点一下，你的位置就保留下来了。",
    headline: "确认你在名单上的位置",
    body: (email) =>
      email
        ? ["我们收到请求，要把 ", { b: email }, " 加入 agentes.chat 的候补名单。"]
        : "我们收到请求，要把这个地址加入 agentes.chat 的候补名单。",
    approve: "在这里，重要的事情都要经过人的批准才会发生。这个请求也一样。",
    button: "确认我的邮箱",
    small: "链接 48 小时内有效。不是你本人？忽略这封邮件即可。不点击链接，这个地址就不会加入名单。",
    why: "你收到这封邮件，是因为有人在 agentes.chat 候补名单中填写了这个地址。",
  },
  earlyAccess: {
    subject: "你的 agentes.chat 邀请到了",
    preheader: (days) => `请在 ${days} 天内用这个邮箱地址创建账号。`,
    headline: "你的访问权限已就绪",
    body: (email) => [{ b: email }, " 现在可以在 agentes.chat 上创建账号和工作区了。"],
    what: "agentes.chat 是成员和 AI 智能体一起工作的地方。",
    button: "创建我的账号",
    small: (days) =>
      `链接 ${days} 天内有效，仅限这个地址使用。你可以用密码注册，也可以用同一地址的 Google、GitHub 或 Apple 账号注册。`,
    why: "你收到这封邮件，是因为这个地址在 agentes.chat 的候补名单上，或者受邀加入了 agentes.chat。在你注册之前，什么都不会发生。",
  },
  earlyAccessAllowed: {
    subject: "你现在可以创建自己的工作区了",
    preheader: "用你现有的账号登录，然后完成设置。",
    headline: "创建你自己的工作区",
    body: (email) => ["你现在可以用现有账号 ", { b: email }, " 在 agentes.chat 上创建自己的工作区了。"],
    button: "创建我的工作区",
    why: "你收到这封邮件，是因为这个账号获得了 agentes.chat 的抢先体验资格。",
  },
  budget: {
    subject: {
      warning: "一个智能体已用掉本月预算的 80%",
      exhausted: "一个智能体已停止：本月预算已用完",
    },
    preheader: {
      warning: "用到 100% 时它会停止，直到下个月或上限调高。",
      exhausted: "在下个月到来或上限调高之前，它不会再回复。",
    },
    headline: { warning: "一个智能体已用掉 80% 的预算", exhausted: "一个智能体的预算已用完" },
    used: (pct, org) => `已用本月预算的 ${pct} · ${org}`,
    warning: "用到 100% 时它会停止，并在频道中说明。管理员可以在智能体页面上修改上限。",
    exhausted: "在下个月到来或管理员调高上限之前，它不会再回复。",
    button: "查看预算",
    why: (org) =>
      `你收到这封邮件，是因为你是这个智能体的负责人，或是 ${org} 的管理员。用到 80% 和 100% 时各发送一次，每月一次。`,
    personal: {
      warning: "用到 100% 时它会停止并告诉你。你可以在智能体页面上修改上限。",
      exhausted: "在下个月到来，或你在智能体页面上调高上限之前，它不会再回复。",
      why: () => "你收到这封邮件，是因为这个智能体是你的。用到 80% 和 100% 时各发送一次，每月一次。",
    },
  },
  digest: {
    subject: (n) => (n === 1 ? "有一个请求等你审批" : `有 ${n} 个请求等你审批`),
    preheader: "请求 24 小时后过期，没有决定就不会执行任何操作。",
    headline: (n) => (n === 1 ? "有一个请求等你处理" : `有 ${n} 个请求等你处理`),
    body: (n, org) => [
      "在 ",
      { b: org },
      n === 1 ? " 中，一个智能体请求做一件只有人能批准的事。" : " 中，多个智能体请求做只有人能批准的事。",
    ],
    age: (h) => `${h} 小时前`,
    more: (k) => `还有 ${k} 个。`,
    button: (n) => (n === 1 ? "查看请求" : "打开审批"),
    why: (org, hours) =>
      `你收到这封邮件，是因为你可以在 ${org} 中批准这些请求。${hours ? `请求等待超过 ${hours} 小时后发送，每个请求只发一次。` : ""}`,
    personal: {
      body: () => "你的智能体请求做需要你批准的事。",
      why: (_org, hours) =>
        `你收到这封邮件，是因为你可以批准这些请求。${hours ? `请求等待超过 ${hours} 小时后发送，每个请求只发一次。` : ""}`,
    },
  },
  ready: {
    subject: "你的智能体的电脑已就绪",
    preheader: {
      ai: "下一步：连接你的 AI，让智能体能够思考。",
      task: "下一步：给智能体布置第一个任务。",
      create: "下一步：创建你的第一个智能体。",
    },
    headline: "你的智能体的电脑已就绪",
    computer: "你的智能体的电脑",
    body: (org) => [
      "感谢耐心等待。",
      { b: org },
      " 的电脑已经开机并设置完毕，每个智能体都有自己的用户。它昼夜不停地运行，你的智能体随时都能工作。",
    ],
    facts: { cpus: "CPU", memory: "内存", disk: "磁盘" },
    next: "下一步",
    steps: {
      ai: ["连接你的 AI。", "用你的 Claude 或 ChatGPT 套餐、其他 AI 的编程套餐或 API 密钥登录。你的智能体用它来思考。"],
      task: ["布置第一个任务。", "在 #general 中用 @ 叫一个智能体，说出你需要什么。"],
      watch: ["看它们工作。", "在智能体页面上点“打开”，就能实时看到它的电脑。你随时可以接管操作，用完再交还给它。"],
      create: ["创建一个智能体。", "它从一开始就在这台电脑上工作。"],
    },
    button: { ai: "连接你的 AI", task: "布置第一个任务", create: "创建智能体" },
    why: (org) => `你收到这封邮件，是因为你是 agentes.chat 上 ${org} 的所有者。关于这台电脑，只会发这一封邮件。`,
    personal: {
      body: () =>
        "感谢耐心等待。你的智能体的电脑已经开机并设置完毕，每个智能体都有自己的用户。它昼夜不停地运行，你的智能体随时都能工作。",
      steps: {
        task: ["布置第一个任务。", "打开和你的某个智能体的对话，说出你需要什么。"],
      },
      why: () => "你收到这封邮件，是因为 agentes.chat 上的这个工作区是你的。关于这台电脑，只会发这一封邮件。",
    },
  },
  joinRequest: {
    subject: "有人请求加入你的工作区",
    preheader: "在“成员”中批准或拒绝。在你回复之前，什么都不会发生。",
    headline: "有一个加入请求等你处理",
    body: (org) => ["对方打开了 ", { b: org }, " 的邀请链接，并请求加入。"],
    note: "只批准你认识的人。除非你在页面上选择其他角色，否则对方会以成员身份加入。",
    approve: "批准",
    deny: "拒绝",
    more: "所有待处理的请求都在“成员”中。",
    why: (org) => `你收到这封邮件，是因为你是 ${org} 的所有者或管理员。每小时最多发送一次。`,
    personal: {
      body: () => "对方打开了你的工作区的邀请链接，并请求加入。",
      why: () => "你收到这封邮件，是因为你负责管理谁加入你的工作区。每小时最多发送一次。",
    },
  },
  joinAnswer: {
    someone: "有人",
    joined: {
      subject: "你的加入请求已获批准",
      preheader: "你已加入。打开工作区开始吧。",
      headline: "你已加入",
      body: (who, org, role) => [`${who} 批准了你的请求。你已以${role}身份加入 `, { b: org }, "。"],
      button: "打开工作区",
    },
    invited: {
      subject: "你的加入请求已获批准",
      preheader: "只差一步：请在 7 天内接受邀请。",
      headline: "已批准，只差一步",
      body: (who, org) => [`${who} 批准了你加入 `, { b: org }, " 的请求。"],
      next: "请在 7 天内用这个邮箱地址接受邀请。",
      button: "接受邀请",
    },
    denied: {
      subject: "你的加入请求未获批准",
      preheader: "工作区的成员查看后没有批准。",
      headline: "你的请求未获批准",
      body: (org) => [{ b: org }, " 的成员查看了你的请求，没有批准。"],
      reason: (reason) => [{ b: "附言：" }, `“${reason}”`],
      small: "如果你觉得这是个误会，请让那里的人通过邮件邀请你。",
    },
    why: (org) => `你收到这封邮件，是因为这个地址请求加入 agentes.chat 上的 ${org}。`,
    personal: {
      joined: { body: (who) => `${who} 批准了你的请求。你现在已加入这个工作区。` },
      invited: { body: (who) => `${who} 批准了你加入工作区的请求。` },
      denied: {
        preheader: "对方查看后没有批准。",
        body: () => "你请求的那个人查看了你的请求，没有批准。",
        small: "如果你觉得这是个误会，请让对方通过邮件邀请你。",
      },
      why: () => "你收到这封邮件，是因为这个地址请求加入 agentes.chat 上的一个个人工作区。",
    },
  },
  joinCode: {
    subject: (code) => `你的 agentes.chat 验证码：${code}`,
    preheader: "在页面上输入它即可请求加入。10 分钟内有效。",
    headline: "你的验证码",
    body: (org) => ["在页面上输入这个验证码，即可请求加入 ", { b: org }, "。"],
    small: "10 分钟内有效。如果不是你本人请求，忽略这封邮件即可。",
    why: (org) => `你收到这封邮件，是因为有人输入了这个地址，请求加入 agentes.chat 上的 ${org}。`,
    personal: {
      body: () => "在页面上输入这个验证码，即可请求加入这个工作区。",
      why: () => "你收到这封邮件，是因为有人输入了这个地址，请求加入 agentes.chat 上的一个个人工作区。",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `删除工作区的验证码：${code}`,
    subjectAccount: (code) => `删除整个账号的验证码：${code}`,
    preheader: "在 agentes.chat 中输入它来确认。10 分钟内有效。",
    headline: "你的验证码",
    workspace: (org) => ["输入这个验证码即可删除工作区 ", { b: org }, "。它会立即对所有人变为只读，7 天后被永久删除。"],
    account: (email) => [
      "输入这个验证码即可删除整个账号 ",
      { b: email },
      "，而不只是一个工作区。账号会立即在所有设备上退出登录，7 天后被永久删除，只有你一人的工作区也会随之关闭。",
    ],
    support: (address) => [
      "验证码 10 分钟内有效，没有它什么都不会被删除。如果不是你本人操作，请不要告诉任何人，并写信至 ",
      { mail: address },
      "。",
    ],
    noSupport:
      "验证码 10 分钟内有效，没有它什么都不会被删除。如果不是你本人操作，请不要告诉任何人，并告知这台服务器的管理人员。",
    whyWorkspace: (org) => `你收到这封邮件，是因为你的账号请求删除 agentes.chat 上的 ${org}。`,
    whyAccount: "你收到这封邮件，是因为你的账号请求在 agentes.chat 上删除自己。",
    personal: {
      workspace: (org) => ["输入这个验证码即可删除你的工作区 ", { b: org }, "。它会立即变为只读，7 天后被永久删除。"],
    },
  },
  deleting: {
    subject: (day) => `你所在的一个工作区将于 ${day} 删除`,
    preheader: "它现在只读。在那之前，所有者仍可恢复它。",
    headline: "一个工作区正在被删除",
    body: (by, org, day, time) => [
      { b: by },
      " 删除了工作区 ",
      { b: org },
      `。它现在只读，将于 ${day} ${time} 被永久删除。`,
    ],
    owner: "改变主意了？在那之前恢复它。",
    button: "恢复工作区",
    member: "如果这是误操作，请让所有者恢复它。",
    why: (org) => `你收到这封邮件，是因为你在 agentes.chat 上的 ${org} 中。`,
    personal: {
      member: "如果这是误操作，请让删除它的人恢复它。",
      why: () => "你收到这封邮件，是因为你在 agentes.chat 上的这个工作区中。",
    },
  },
  restored: {
    subject: "你所在的一个工作区已恢复",
    preheader: "所有者恢复了它，现在可以正常使用了。",
    headline: "工作区已恢复",
    body: (by, org) => [{ b: by }, " 恢复了 ", { b: org }, "，现在可以正常使用了。"],
    button: "打开工作区",
    why: (org) => `你收到这封邮件，是因为你在 agentes.chat 上的 ${org} 中。`,
    personal: {
      why: () => "你收到这封邮件，是因为你在 agentes.chat 上的这个工作区中。",
    },
  },
  appConnected: {
    subject: "有应用连接到了你的 agentes.chat 账号",
    preheader: "它可以在一个工作区中以你的身份查看任务、给智能体发送任务。",
    headline: "有应用连接了",
    body: (app, org) => [{ b: app }, " 现在可以访问你在 ", { b: org }, " 的账号。"],
    note: "不是你连接的？请立即断开它，并修改密码。",
    button: "查看已连接的应用",
    why: (org) => `你收到这封邮件，是因为有应用连接到了你在 agentes.chat 上 ${org} 的账号。`,
    personal: {
      body: (app) => [{ b: app }, " 现在可以访问你在个人工作区中的账号。"],
      why: () => "你收到这封邮件，是因为有应用连接到了你在 agentes.chat 个人工作区中的账号。",
    },
  },
  accountDeleting: {
    subject: (day) => `你的 agentes.chat 账号将于 ${day} 删除`,
    preheader: "你有 7 天时间改变主意。",
    headline: "你的账号正在删除",
    body: (email, day, time) => [
      "我们将删除账号 ",
      { b: email },
      `，时间是 ${day} ${time}。它已在所有设备上退出登录，在你回来之前，这里没有人能联系到你。`,
    ],
    closes: (_count, names) => ["只有你一人的工作区现已关闭，并在同一天删除：", ...names, "。"],
    undo: "改变主意了？在那之前登录并点击“恢复”。",
    button: "登录并恢复",
    why: "你收到这封邮件，是因为这个地址在 agentes.chat 上有一个账号。",
  },
  accountDeleted: {
    subject: "你的 agentes.chat 账号已删除",
    preheader: "它已在所有设备上退出登录，无法再次登录。",
    headline: "你的账号已删除",
    body: (email) => ["我们删除了账号 ", { b: email }, "。"],
    closes: (_count, day, names) => [`只有你一人的工作区已关闭，将于 ${day} 被永久删除：`, ...names, "。"],
    support: (address) => ["如果不是你本人操作，请写信至 ", { mail: address }, "。"],
    noSupport: "如果不是你本人操作，请告知这台服务器的管理人员。",
    why: "你收到这封邮件，是因为这个地址在 agentes.chat 上有一个账号。",
  },
  autonomy: {
    subject: (day, stalls, noise) => `${day} 的智能体：${stalls} 次卡住，${noise} 次空转`,
    preheader: "智能体在哪里停下、在哪里白忙一场，与之前 7 天对比。",
    headline: (day) => `${day} 的卡住与空转`,
    body: "这台服务器上所有活跃的工作区，按 UTC 计的一天。只有名称和次数。",
    stalls: "卡住",
    noise: "空转",
    metric: {
      mentionNoRun: "没有唤醒任何智能体的提及",
      readOnly: "只能读取的运行",
      promiseUnkept: "留下未完成的工作就结束",
      promiseIgnored: "提醒后仍未完成",
      handoffUnanswered: "30 分钟内无人接手的交接",
      limitStops: "因上限而停止",
      personUnanswered: "10 分钟内未获回复的人",
      taskStartFailed: "一开始就失败的任务",
      noiseRuns: "白跑的运行",
      quietRuns: "一言不发就结束",
      ackReplies: "回复了一句谢谢或好的",
      idleWakes: "被唤醒却无事可做",
      noiseTokens: "它们的 token 数",
      noiseCostNanoUsd: "它们的费用",
    },
    value: (today, average) => `${today} · 7 天平均 ${average}`,
    topStalls: "卡住最多",
    topNoise: "白跑最多，附费用",
    none: "没有工作区。",
    table: (day) => `完整表格：bun run report:autonomy --day ${day}`,
    why: "你收到这封邮件，是因为这个地址配置在这台服务器的 OPS_REPORT_EMAIL 中。每天发送一次。",
  },
  planOpened: {
    subject: (plan) => `更多人可以通过你的 ${plan} 套餐和你的智能体对话`,
    preheader: (plan) => `他们的对话会使用你的 ${plan} 套餐及其额度。`,
    headline: "更多人可以和你的智能体对话",
    body: (by, agent, plan) => [
      { b: by },
      " 让更多人可以和 ",
      { b: agent },
      ` 对话。他们的对话会使用你的 ${plan} 套餐及其额度。`,
    ],
    agent: "智能体",
    by: "修改人",
    was: "之前",
    now: "现在",
    everyone: "工作区里的所有人",
    onlyYou: "只有你",
    you: "你",
    note: "要撤销，请在智能体页面修改谁可以对话。",
    button: "查看谁可以对话",
    why: (org) => `你收到这封邮件，是因为你在 ${org} 的智能体使用你的套餐思考，而其他人修改了谁可以和它对话。`,
    personal: {
      why: () => "你收到这封邮件，是因为你的一个智能体使用你的套餐思考，而其他人修改了谁可以和它对话。",
    },
  },
  planLent: {
    subject: (plan) => `你的 ${plan} 套餐现在在为另一个智能体思考`,
    preheader: (plan) => `它的对话会使用你的 ${plan} 套餐及其额度。你可以收回。`,
    headline: "有人把你的套餐连接到了一个智能体",
    body: (by, agent, plan) => [
      { b: by },
      ` 把你的 ${plan} 套餐连接到了智能体 `,
      { b: agent },
      "。它的对话会使用你的套餐及其额度。",
    ],
    agent: "智能体",
    by: "连接者",
    plan: "套餐",
    note: "在通知里点一下就能收回，之后这个智能体不再用你的套餐思考。",
    button: "打开通知",
    why: (org) => `你收到这封邮件，是因为 ${org} 里有人把你的套餐连接到了一个智能体。`,
    personal: {
      why: () => "你收到这封邮件，是因为你的工作区里有人把你的套餐连接到了一个智能体。",
    },
  },
  planWaiting: {
    subject: "你的团队正在等待",
    preheader: "你的工作区已就绪。还需要一个 agentes.chat 套餐才能开始。",
    headline: "你的团队正在等待",
    body: (agents, channels, routines) => {
      const a = `${agents} 个智能体`;
      const c = `${channels} 个频道`;
      const r = `${routines} 个例行任务`;
      return routines > 0
        ? `${a}、${c}和${r}已就绪。还需要一个 agentes.chat 套餐才能开始。`
        : `${a}和${c}已就绪。还需要一个 agentes.chat 套餐才能开始。`;
    },
    button: "查看 agentes.chat 套餐",
    why: (org) => `你收到这封邮件，是因为你在 agentes.chat 上管理 ${org}。此类提醒只发送两次。`,
    personal: {
      subject: "你的智能体正在等待",
      headline: "你的智能体正在等待",
      body: (agents, _channels, routines) => {
        const a = `${agents} 个智能体`;
        const r = `${routines} 个例行任务`;
        return `${routines > 0 ? `${a}和${r}` : a}已就绪。只差一个 agentes.chat 套餐了。`;
      },
      why: () => "你收到这封邮件，是因为 agentes.chat 上的这个工作区是你的。此类提醒只发送两次。",
    },
  },
};
