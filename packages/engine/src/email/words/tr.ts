import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in tr: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("tr", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) =>
    host
      ? atHost("agentes.chat sunucusu tarafından gönderildi.", "Sunucu:", host)
      : "agentes.chat tarafından gönderildi.",
  fallback: "Düğme çalışmıyor mu? Bu adresi tarayıcınıza kopyalayın:",
  role: { owner: "sahip", member: "üye" },
  anAgent: "Bir ajan",
  someone: "Biri",
  verify: {
    subject: "agentes.chat için e-postanızı onaylayın",
    preheader: "Bu adresi onaylamak için tek tık yeterli. Bağlantı bir saat geçerli.",
    headline: "E-postanızı onaylayın",
    body: "Son bir adım kaldı: bu adresin size ait olduğunu onaylayın.",
    button: "E-postayı onayla",
    small: "Bağlantı bir saat geçerli. Kaydolan siz değilseniz bu e-postayı yok sayabilirsiniz.",
    why: "Bu e-postayı, bu adresle agentes.chat'e kaydolunduğu için aldınız.",
  },
  reset: {
    subject: "agentes.chat şifrenizi sıfırlayın",
    preheader: "Yeni bir şifre belirleyin. Bağlantı bir saat geçerli.",
    headline: "Yeni bir şifre belirleyin",
    body: "Bu adresin şifresini sıfırlamak için bir istek aldık.",
    button: "Yeni şifre belirle",
    note: "Bunu siz istemediniz mi? Bu e-postayı yok sayın. Şifreniz aynı kalır.",
    small: "Bağlantı bir saat geçerli.",
    why: "Bu e-postayı, biri agentes.chat'te bu adresin şifresini sıfırlamak istediği için aldınız.",
  },
  invitation: {
    subject: "agentes.chat'te bir çalışma alanına davet edildiniz",
    preheader: "Bu e-posta adresiyle 7 gün içinde kabul edin.",
    headline: "Bir çalışma alanına davet edildiniz",
    body: (inviter, email, org, role) =>
      inviter
        ? [
            { b: inviter },
            `${email ? ` (${email})` : ""} sizi `,
            { b: org },
            ` çalışma alanına ${role} olarak davet etti.`,
          ]
        : [{ b: org }, ` çalışma alanına ${role} olarak davet edildiniz.`],
    what: "agentes.chat, kişilerin ve yapay zeka ajanlarının birlikte çalıştığı yer.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Davet notu: " }, `“${note}”`],
    button: "Daveti kabul et",
    small: "Davet 7 gün geçerli. Bu e-posta adresiyle kabul edin.",
    why: (org) =>
      `Bu e-postayı, ${org} çalışma alanından biri bu adresi davet ettiği için aldınız. Bu kişiyi tanımıyorsanız yok sayın. Siz kabul edene kadar hiçbir şey olmaz.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} sizi agentes.chat'teki kişisel çalışma alanına davet etti.`]
          : "agentes.chat'te kişisel bir çalışma alanına davet edildiniz.",
      why: () =>
        "Bu e-postayı, biri bu adresi kendi kişisel çalışma alanına davet ettiği için aldınız. Bu kişiyi tanımıyorsanız yok sayın. Siz kabul edene kadar hiçbir şey olmaz.",
    },
  },
  inviteRequest: {
    subject: "Biri yeni bir davet istedi",
    preheader: "Davetin süresi dolmuş. Üyeler sayfasından yenisini gönderebilirsiniz.",
    headline: "Biri yeni bir davet istedi",
    body: (email, org) =>
      email
        ? [{ b: email }, " süresi dolmuş bir ", { b: org }, " davetini açtı ve yenisini istedi."]
        : ["Süresi dolmuş bir ", { b: org }, " davet bağlantısı olan biri yenisini istedi."],
    next: "Bu kişiyi bekliyorsanız Üyeler sayfasından yeni bir davet gönderin. Beklemiyorsanız yapmanız gereken bir şey yok.",
    button: "Üyeler sayfasını aç",
    why: (org) =>
      `Bu e-postayı, bu daveti siz oluşturduğunuz ya da ${org} çalışma alanının üyelerini yönettiğiniz için aldınız.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " çalışma alanınıza ait süresi dolmuş bir daveti açtı ve yenisini istedi."]
          : "Çalışma alanınıza ait süresi dolmuş bir davet bağlantısı olan biri yenisini istedi.",
      why: () =>
        "Bu e-postayı, bu daveti siz oluşturduğunuz ya da çalışma alanınızda kimlerin olacağına siz karar verdiğiniz için aldınız.",
    },
  },
  calendar: {
    subject: "Bir etkinliğe davet edildiniz",
    preheader: (when) => `${when}. Takvimde görün.`,
    headline: "Bir etkinliğe davet edildiniz",
    facts: { event: "Etkinlik", when: "Ne zaman", org: "Çalışma alanı", by: "Davet eden" },
    someone: "Biri",
    button: "Etkinliği gör",
    why: (org) => `Bu e-postayı, ${org} çalışma alanından biri sizi bir etkinliğe davet ettiği için aldınız.`,
    personal: {
      why: () => "Bu e-postayı, çalışma alanınızdan biri sizi bir etkinliğe davet ettiği için aldınız.",
    },
  },
  waitlist: {
    subject: "agentes.chat bekleme listesindeki yerinizi onaylayın",
    preheader: "Tek tıkla yeriniz ayrılır.",
    headline: "Listedeki yerinizi onaylayın",
    body: (email) =>
      email
        ? [{ b: email }, " adresini agentes.chat bekleme listesine eklemek için bir istek aldık."]
        : "Bu adresi agentes.chat bekleme listesine eklemek için bir istek aldık.",
    approve: "Burada önemli hiçbir şey bir kişi onaylamadan olmaz. Bu istek de öyle.",
    button: "E-postamı onayla",
    small:
      "Bağlantı 48 saat geçerli. Siz değil miydiniz? Bu e-postayı yok sayın. Tıklamazsanız adres listeye hiç eklenmez.",
    why: "Bu e-postayı, bu adres agentes.chat bekleme listesine yazıldığı için aldınız.",
  },
  earlyAccess: {
    subject: "agentes.chat davetiniz geldi",
    preheader: (days) => `Bu e-posta adresiyle ${days} gün içinde hesabınızı oluşturun.`,
    headline: "Erişiminiz hazır",
    body: (email) => [{ b: email }, " artık agentes.chat'te bir hesap ve bir çalışma alanı oluşturabilir."],
    what: "agentes.chat, kişilerin ve yapay zeka ajanlarının birlikte çalıştığı yer.",
    button: "Hesabımı oluştur",
    small: (days) =>
      `Bağlantı ${days} gün boyunca ve yalnızca bu adres için geçerli. Bir şifreyle ya da aynı adresle Google, GitHub veya Apple üzerinden kaydolun.`,
    why: "Bu e-postayı, bu adres agentes.chat bekleme listesinde olduğu ya da agentes.chat'e davet edildiği için aldınız. Siz kaydolana kadar hiçbir şey olmaz.",
  },
  earlyAccessAllowed: {
    subject: "Artık kendi çalışma alanınızı oluşturabilirsiniz",
    preheader: "Mevcut hesabınızla giriş yapın ve kurulumu yapın.",
    headline: "Kendi çalışma alanınızı oluşturun",
    body: (email) => [
      "Artık mevcut hesabınız ",
      { b: email },
      " ile agentes.chat'te kendi çalışma alanınızı oluşturabilirsiniz.",
    ],
    button: "Çalışma alanımı oluştur",
    why: "Bu e-postayı, bu hesaba agentes.chat'e erken erişim verildiği için aldınız.",
  },
  budget: {
    subject: {
      warning: "Bir ajan aylık bütçesinin %80'ini aştı",
      exhausted: "Bir ajan durdu: aylık bütçeye ulaşıldı",
    },
    preheader: {
      warning: "%100'de, yeni ay başlayana ya da limit artırılana kadar durur.",
      exhausted: "Yeni ay başlayana ya da limit artırılana kadar yanıt vermeyecek.",
    },
    headline: { warning: "Bir ajan bütçesinin %80'ini aştı", exhausted: "Bir ajan bütçesine ulaştı" },
    used: (pct, org) => `Bu ayın bütçesinden kullanılan: ${pct} · ${org}`,
    warning: "%100'de durur ve bunu kanalda söyler. Bir yönetici limiti ajanın sayfasından değiştirebilir.",
    exhausted: "Yeni ay başlayana ya da bir yönetici limiti artırana kadar yanıt vermeyecek.",
    button: "Bütçeyi gör",
    why: (org) =>
      `Bu e-postayı, bu ajanın sahibi ya da ${org} çalışma alanının yöneticisi olduğunuz için aldınız. %80'de ve %100'de, her biri ayda bir kez gönderilir.`,
    personal: {
      warning: "%100'de durur ve size haber verir. Limiti ajanın sayfasından değiştirebilirsiniz.",
      exhausted: "Yeni ay başlayana ya da siz limiti ajanın sayfasından artırana kadar yanıt vermeyecek.",
      why: () =>
        "Bu e-postayı, bu ajan sizin olduğu için aldınız. %80'de ve %100'de, her biri ayda bir kez gönderilir.",
    },
  },
  digest: {
    subject: (n) =>
      plural("tr", n, {
        one: "Onayınızı bekleyen bir istek var",
        other: `Onayınızı bekleyen ${n} istek var`,
      }),
    preheader: "İstekler 24 saat sonra sona erer ve karar verilmeden hiçbir şey çalışmaz.",
    headline: (n) => plural("tr", n, { one: "Sizi bekleyen bir istek var", other: `Sizi bekleyen ${n} istek var` }),
    body: (n, org) => [
      { b: org },
      plural("tr", n, {
        one: " çalışma alanında bir ajan, yalnızca bir kişinin onaylayabileceği bir şey yapmak istedi.",
        other: ` çalışma alanında ajanlar, yalnızca bir kişinin onaylayabileceği ${n} şey yapmak istedi.`,
      }),
    ],
    age: (h) => `${h} sa önce`,
    more: (k) => `Ve ${k} tane daha.`,
    button: (n) => plural("tr", n, { one: "İsteği incele", other: "Onayları aç" }),
    why: (org, hours) =>
      `Bu e-postayı, ${org} çalışma alanında bu istekleri onaylayabildiğiniz için aldınız.${hours ? ` Bir istek ${hours} saatten uzun beklediğinde, her istek için bir kez gönderilir.` : ""}`,
    personal: {
      body: (n) =>
        plural("tr", n, {
          one: "Ajanlarınızdan biri onayınızı gerektiren bir şey yapmak istedi.",
          other: "Ajanlarınız onayınızı gerektiren şeyler yapmak istedi.",
        }),
      why: (_org, hours) =>
        `Bu e-postayı, bu istekleri onaylayabildiğiniz için aldınız.${hours ? ` Bir istek ${hours} saatten uzun beklediğinde, her istek için bir kez gönderilir.` : ""}`,
    },
  },
  ready: {
    subject: "Ajanlarınızın bilgisayarı hazır",
    preheader: {
      ai: "Sırada: ajanlarınız düşünebilsin diye yapay zekanızı bağlayın.",
      task: "Sırada: ajanlarınıza ilk görevi verin.",
      create: "Sırada: ilk ajanınızı oluşturun.",
    },
    headline: "Ajanlarınızın bilgisayarı hazır",
    computer: "Ajanlarınızın bilgisayarı",
    body: (org) => [
      "Beklediğiniz için teşekkürler. ",
      { b: org },
      " çalışma alanının bilgisayarı açık ve kurulu, her ajan için ayrı bir kullanıcısı var. Gece gündüz açık kalır, böylece ajanlarınız her an çalışabilir.",
    ],
    facts: { cpus: "CPU", memory: "Bellek", disk: "Disk" },
    next: "Sonraki adımlar",
    steps: {
      ai: [
        "Yapay zekanızı bağlayın.",
        "Claude ya da ChatGPT planınızla, başka bir yapay zekanın kodlama planıyla ya da bir API anahtarıyla giriş yapın. Ajanlarınız onunla düşünür.",
      ],
      task: ["İlk görevi verin.", "#general kanalında @ ile bir ajanı çağırın ve neye ihtiyacınız olduğunu söyleyin."],
      watch: [
        "Çalışmalarını izleyin.",
        "Bir ajanın sayfasında Aç'a basın ve bilgisayarını canlı görün. İstediğiniz an kontrolü alın, işiniz bitince geri verin.",
      ],
      create: ["Bir ajan oluşturun.", "En baştan bu bilgisayarda çalışır."],
    },
    button: { ai: "Yapay zekayı bağla", task: "İlk görevi ver", create: "Ajan oluştur" },
    why: (org) =>
      `Bu e-postayı, agentes.chat'teki ${org} çalışma alanının sahibi olduğunuz için aldınız. Bu bilgisayarla ilgili gönderilen tek e-posta bu.`,
    personal: {
      body: () =>
        "Beklediğiniz için teşekkürler. Ajanlarınızın bilgisayarı açık ve kurulu, her ajan için ayrı bir kullanıcısı var. Gece gündüz açık kalır, böylece ajanlarınız her an çalışabilir.",
      steps: {
        task: ["İlk görevi verin.", "Ajanlarınızdan biriyle bir konuşma açın ve neye ihtiyacınız olduğunu söyleyin."],
      },
      why: () =>
        "Bu e-postayı, agentes.chat'teki bu çalışma alanı size ait olduğu için aldınız. Bu bilgisayarla ilgili gönderilen tek e-posta bu.",
    },
  },
  joinRequest: {
    subject: "Biri çalışma alanınıza katılmak istiyor",
    preheader: "Üyeler sayfasında onaylayın ya da reddedin. Siz yanıt verene kadar hiçbir şey olmaz.",
    headline: "Bir katılma isteği bekliyor",
    body: (org) => ["Biri ", { b: org }, " davet bağlantısını açıp katılmak istedi."],
    note: "Yalnızca beklediğiniz kişileri onaylayın. Sayfada başka bir rol seçmezseniz üye olarak katılırlar.",
    approve: "Onayla",
    deny: "Reddet",
    more: "Bekleyen tüm istekler Üyeler sayfasında.",
    why: (org) =>
      `Bu e-postayı, ${org} çalışma alanının sahibi ya da yöneticisi olduğunuz için aldınız. En fazla saatte bir gönderilir.`,
    personal: {
      body: () => "Biri çalışma alanınızın davet bağlantısını açıp katılmak istedi.",
      why: () =>
        "Bu e-postayı, çalışma alanınıza kimlerin katılacağına siz karar verdiğiniz için aldınız. En fazla saatte bir gönderilir.",
    },
  },
  joinAnswer: {
    someone: "Biri",
    joined: {
      subject: "Katılma isteğiniz onaylandı",
      preheader: "Artık içeridesiniz. Başlamak için çalışma alanını açın.",
      headline: "Artık içeridesiniz",
      body: (who, org, role) => [
        `${who} isteğinizi onayladı. `,
        { b: org },
        ` çalışma alanına ${role} olarak katıldınız.`,
      ],
      button: "Çalışma alanını aç",
    },
    invited: {
      subject: "Katılma isteğiniz onaylandı",
      preheader: "Son bir adım kaldı: daveti 7 gün içinde kabul edin.",
      headline: "Onaylandı: son bir adım kaldı",
      body: (who, org) => [`${who}, `, { b: org }, " çalışma alanına katılma isteğinizi onayladı."],
      next: "Daveti bu e-posta adresiyle 7 gün içinde kabul edin.",
      button: "Daveti kabul et",
    },
    denied: {
      subject: "Katılma isteğiniz onaylanmadı",
      preheader: "Çalışma alanından biri isteğinize baktı ve onaylamadı.",
      headline: "İsteğiniz onaylanmadı",
      body: (org) => [{ b: org }, " çalışma alanından biri isteğinize baktı ve onaylamadı."],
      reason: (reason) => [{ b: "Gerekçe: " }, `“${reason}”`],
      small: "Bir yanlışlık olduğunu düşünüyorsanız oradan birinden sizi e-postayla davet etmesini isteyin.",
    },
    why: (org) =>
      `Bu e-postayı, bu adresle agentes.chat'te ${org} çalışma alanına katılma isteği gönderildiği için aldınız.`,
    personal: {
      joined: { body: (who) => `${who} isteğinizi onayladı. Artık onun çalışma alanındasınız.` },
      invited: { body: (who) => `${who}, kendi çalışma alanına katılma isteğinizi onayladı.` },
      denied: {
        preheader: "İsteğinize baktı ve onaylamadı.",
        body: () => "İstek gönderdiğiniz kişi isteğinize baktı ve onaylamadı.",
        small: "Bir yanlışlık olduğunu düşünüyorsanız bu kişiden sizi e-postayla davet etmesini isteyin.",
      },
      why: () =>
        "Bu e-postayı, bu adresle agentes.chat'te kişisel bir çalışma alanına katılma isteği gönderildiği için aldınız.",
    },
  },
  joinCode: {
    subject: (code) => `agentes.chat kodunuz: ${code}`,
    preheader: "Katılma isteği göndermek için sayfaya yazın. 10 dakika geçerli.",
    headline: "Kodunuz",
    body: (org) => [{ b: org }, " çalışma alanına katılma isteği göndermek için bu kodu sayfaya yazın."],
    small: ["10 dakika geçerli. Siz istemediyseniz ", { nobr: "bu e-postayı yok sayın." }],
    why: (org) =>
      `Bu e-postayı, biri agentes.chat'te ${org} çalışma alanına katılmak için bu adresi yazdığı için aldınız.`,
    personal: {
      body: () => "Bu çalışma alanına katılma isteği göndermek için bu kodu sayfaya yazın.",
      why: () =>
        "Bu e-postayı, biri agentes.chat'te kişisel bir çalışma alanına katılmak için bu adresi yazdığı için aldınız.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `Çalışma alanı silme kodunuz: ${code}`,
    subjectAccount: (code) => `Hesabınızın tamamını silme kodunuz: ${code}`,
    preheader: "Onaylamak için agentes.chat'e yazın. 10 dakika geçerli.",
    headline: "Kodunuz",
    workspace: (org) => [
      { b: org },
      " çalışma alanını silmek için bu kodu yazın. Çalışma alanı herkes için hemen salt okunur olur ve 7 gün sonra kalıcı olarak silinir.",
    ],
    account: (email) => [
      { b: email },
      " hesabının tamamını silmek için bu kodu yazın, yalnızca bir çalışma alanını değil. Hesabın oturumu her yerde hemen kapanır, hesap 7 gün sonra kalıcı olarak silinir ve yalnızca sizin bulunduğunuz çalışma alanları da onunla birlikte kapanır.",
    ],
    support: (address) => [
      "10 dakika geçerli ve bu kod olmadan hiçbir şey silinmez. Bu siz değilseniz kodu kimseyle paylaşmayın ve ",
      { mail: address },
      " adresine yazın.",
    ],
    noSupport:
      "10 dakika geçerli ve bu kod olmadan hiçbir şey silinmez. Bu siz değilseniz kodu kimseyle paylaşmayın ve bu sunucuyu yönetenlere haber verin.",
    whyWorkspace: (org) =>
      `Bu e-postayı, hesabınızdan agentes.chat'te ${org} çalışma alanının silinmesi istendiği için aldınız.`,
    whyAccount: "Bu e-postayı, hesabınızdan agentes.chat'te hesabın silinmesi istendiği için aldınız.",
    personal: {
      workspace: (org) => [
        { b: org },
        " çalışma alanınızı silmek için bu kodu yazın. Hemen salt okunur olur ve 7 gün sonra kalıcı olarak silinir.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Bulunduğunuz bir çalışma alanı ${day} tarihinde silinecek`,
    preheader: "Şu anda salt okunur. Bir sahip o zamana kadar geri yükleyebilir.",
    headline: "Bir çalışma alanı siliniyor",
    body: (by, org, day, time) => [
      { b: by },
      ", ",
      { b: org },
      ` çalışma alanını sildi. Şu anda salt okunur ve ${day} ${time} itibarıyla kalıcı olarak silinecek.`,
    ],
    owner: "Fikrinizi mi değiştirdiniz? O zamana kadar geri yükleyin.",
    button: "Çalışma alanını geri yükle",
    member: "Bir yanlışlık varsa bir sahipten geri yüklemesini isteyin.",
    why: (org) => `Bu e-postayı, agentes.chat'te ${org} çalışma alanında bulunduğunuz için aldınız.`,
    personal: {
      member: "Bir yanlışlık varsa silen kişiden geri yüklemesini isteyin.",
      why: () => "Bu e-postayı, agentes.chat'teki bu çalışma alanında bulunduğunuz için aldınız.",
    },
  },
  restored: {
    subject: "Bulunduğunuz bir çalışma alanı geri geldi",
    preheader: "Bir sahip geri yükledi. Yeniden çalışıyor.",
    headline: "Çalışma alanı geri geldi",
    body: (by, org) => [{ b: by }, ", ", { b: org }, " çalışma alanını geri yükledi. Yeniden çalışıyor."],
    button: "Çalışma alanını aç",
    why: (org) => `Bu e-postayı, agentes.chat'te ${org} çalışma alanında bulunduğunuz için aldınız.`,
    personal: {
      why: () => "Bu e-postayı, agentes.chat'teki bu çalışma alanında bulunduğunuz için aldınız.",
    },
  },
  appConnected: {
    subject: "agentes.chat hesabınıza bir uygulama bağlandı",
    preheader: "Bir çalışma alanında sizin adınıza okuyabilir ve ajanlara görev gönderebilir.",
    headline: "Bir uygulama bağlandı",
    body: (app, org) => [{ b: app }, " artık ", { b: org }, " çalışma alanındaki hesabınıza erişebiliyor."],
    note: "Siz bağlamadınız mı? Hemen bağlantısını kesin ve şifrenizi değiştirin.",
    button: "Bağlı uygulamaları gör",
    why: (org) =>
      `Bu e-postayı, agentes.chat'te ${org} çalışma alanındaki hesabınıza bir uygulama bağlandığı için aldınız.`,
    personal: {
      body: (app) => [{ b: app }, " artık kişisel çalışma alanınızdaki hesabınıza erişebiliyor."],
      why: () =>
        "Bu e-postayı, agentes.chat'teki kişisel çalışma alanınızda hesabınıza bir uygulama bağlandığı için aldınız.",
    },
  },
  accountDeleting: {
    subject: (day) => `agentes.chat hesabınız ${day} tarihinde silinecek`,
    preheader: "Fikrinizi değiştirmek için 7 gününüz var.",
    headline: "Hesabınız siliniyor",
    body: (email, day, time) => [
      { b: email },
      ` hesabını ${day} ${time} tarihinde sileceğiz. Her yerde oturumu kapatıldı ve siz dönene kadar burada kimse size ulaşamaz.`,
    ],
    closes: (count, names) => [
      plural("tr", count, {
        one: "Yalnızca sizin bulunduğunuz çalışma alanı şimdi kapandı ve aynı tarihte silinecek: ",
        other: "Yalnızca sizin bulunduğunuz çalışma alanları şimdi kapandı ve aynı tarihte silinecek: ",
      }),
      ...names,
      ".",
    ],
    undo: "Fikrinizi mi değiştirdiniz? Bu tarihten önce giriş yapın ve Geri yükle düğmesine basın.",
    button: "Giriş yap ve geri yükle",
    why: "Bu e-postayı, bu adresin agentes.chat’te bir hesabı olduğu için aldınız.",
  },
  accountDeleted: {
    subject: "agentes.chat hesabınız silindi",
    preheader: "Her yerde oturumu kapatıldı ve bir daha giriş yapılamaz.",
    headline: "Hesabınız silindi",
    body: (email) => [{ b: email }, " hesabını sildik."],
    closes: (count, day, names) => [
      plural("tr", count, {
        one: `Yalnızca sizin bulunduğunuz çalışma alanı kapatıldı ve ${day} tarihinde kalıcı olarak silinecek: `,
        other: `Yalnızca sizin bulunduğunuz ${count} çalışma alanı kapatıldı ve ${day} tarihinde kalıcı olarak silinecek: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Bu siz değilseniz ", { mail: address }, " adresine yazın."],
    noSupport: "Bu siz değilseniz bu sunucuyu yönetenlere haber verin.",
    why: "Bu e-postayı, bu adresin agentes.chat'te bir hesabı olduğu için aldınız.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `${day} tarihinde ajanlar: ${stalls} takılma, ${noise} boşa çalışma`,
    preheader: "Ajanların nerede durduğu ve nerede boşuna harekete geçtiği, önceki 7 günle karşılaştırmalı.",
    headline: (day) => `${day} tarihindeki takılmalar ve boşa çalışmalar`,
    body: "Bu sunucudaki tüm etkin çalışma alanları, UTC gününe göre. Yalnızca adlar ve sayılar.",
    stalls: "Takılmalar",
    noise: "Boşa çalışmalar",
    metric: {
      mentionNoRun: "Kimseyi uyandırmayan bahsetmeler",
      readOnly: "Yalnızca okuyabilen çalıştırmalar",
      promiseUnkept: "Yarım iş bırakarak bitenler",
      promiseIgnored: "Hatırlatmadan sonra hâlâ yarım kalanlar",
      handoffUnanswered: "30 dakikada yanıtlanmayan devirler",
      limitStops: "Bir limit yüzünden duranlar",
      personUnanswered: "10 dakikada yanıt alamayan kişiler",
      taskStartFailed: "Başlarken başarısız olan görevler",
      noiseRuns: "Boşa çalışmalar",
      quietRuns: "Tek kelime etmeden bitenler",
      ackReplies: "Bir teşekküre ya da tamama yanıt verenler",
      idleWakes: "Yapacak işi yokken uyandırılanlar",
      noiseTokens: "Token sayıları",
      noiseCostNanoUsd: "Maliyetleri",
    },
    value: (today, average) => `${today} · 7 günlük ortalama ${average}`,
    topStalls: "En çok takılanlar",
    topNoise: "En çok boşa çalışanlar, maliyetleriyle",
    none: "Çalışma alanı yok.",
    table: (day) => `Tablonun tamamı: bun run report:autonomy --day ${day}`,
    why: "Bu e-postayı, bu adres bu sunucudaki OPS_REPORT_EMAIL içinde olduğu için aldınız. Günde bir kez gönderilir.",
  },
  planOpened: {
    subject: (plan) => `${plan} planın üzerinden ajanınla daha fazla kişi konuşabilir`,
    preheader: (plan) => `Onların konuşmaları ${plan} planını ve limitlerini kullanır.`,
    headline: "Ajanınla daha fazla kişi konuşabilir",
    body: (by, agent, plan) => [
      { b: by },
      ", ",
      { b: agent },
      ` ile daha fazla kişinin konuşmasına izin verdi. Onların konuşmaları ${plan} planını ve limitlerini kullanır.`,
    ],
    agent: "Ajan",
    by: "Değiştiren",
    was: "Önce",
    now: "Şimdi",
    everyone: "Workspace'teki herkes",
    onlyYou: "Yalnızca sen",
    you: "Sen",
    note: "Geri almak için ajanın sayfasında Kimler konuşabilir ayarını değiştir.",
    button: "Kimlerin konuşabildiğini gör",
    why: (org) =>
      `Bu e-postayı, ${org} içindeki bir ajanın senin planınla düşündüğü ve başka biri onunla kimlerin konuşabileceğini değiştirdiği için aldın.`,
    personal: {
      why: () =>
        "Bu e-postayı, ajanlarından biri senin planınla düşündüğü ve başka biri onunla kimlerin konuşabileceğini değiştirdiği için aldın.",
    },
  },
  planLent: {
    subject: (plan) => `${plan} planın artık başka bir ajan için düşünüyor`,
    preheader: (plan) => `Onun konuşmaları ${plan} planını ve limitlerini kullanır. Geri alabilirsin.`,
    headline: "Biri planını bir ajana bağladı",
    body: (by, agent, plan) => [
      { b: by },
      ` ${plan} planını `,
      { b: agent },
      " ajanına bağladı. Onun konuşmaları planını ve limitlerini kullanır.",
    ],
    agent: "Ajan",
    by: "Bağlayan",
    plan: "Plan",
    note: "Bildirimlerinden tek tıkla geri al, ajan artık planınla düşünmez.",
    button: "Bildirimleri aç",
    why: (org) => `Bu e-postayı ${org} içinde biri planını bir ajana bağladığı için aldın.`,
    personal: {
      why: () => "Bu e-postayı çalışma alanında biri planını bir ajana bağladığı için aldın.",
    },
  },
  planWaiting: {
    subject: "Ekibin bekliyor",
    preheader: "Çalışma alanın hazır. Başlamak için bir agentes.chat planı gerekiyor.",
    headline: "Ekibin bekliyor",
    body: (agents, channels, routines) => {
      const a = plural("tr", agents, { one: `1 ajan`, other: `${agents} ajan` });
      const c = plural("tr", channels, { one: `1 kanal`, other: `${channels} kanal` });
      const r = plural("tr", routines, { one: `1 rutin`, other: `${routines} rutin` });
      return routines > 0
        ? `${a}, ${c} ve ${r} hazır. Başlamak için bir agentes.chat planı gerekiyor.`
        : `${a} ve ${c} hazır. Başlamak için bir agentes.chat planı gerekiyor.`;
    },
    button: "agentes.chat planlarını gör",
    why: (org) =>
      `Bu e-postayı agentes.chat üzerinde ${org} alanını yönettiğin için aldın. Bu bildirimden yalnızca iki tane gönderiyoruz.`,
    personal: {
      subject: "Ajanların bekliyor",
      headline: "Ajanların bekliyor",
      body: (agents, _channels, routines) => {
        const a = plural("tr", agents, { one: `1 ajan`, other: `${agents} ajan` });
        const r = plural("tr", routines, { one: `1 rutin`, other: `${routines} rutin` });
        return `Hazır: ${routines > 0 ? `${a} ve ${r}` : a}. Eksik olan tek şey bir agentes.chat planı.`;
      },
      why: () =>
        "Bu e-postayı, agentes.chat'teki bu çalışma alanı sana ait olduğu için aldın. Bu bildirimden yalnızca iki tane gönderiyoruz.",
    },
  },
};
