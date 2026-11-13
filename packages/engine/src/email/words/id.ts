import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in id: whatever is here replaces English, word group by word group (`deepMerge`). Indonesian has a
 * single plural form, so a count's words differ only where one reads differently (`n === 1`).
 */
export const words: EmailWords = {
  sentBy: (host) => (host ? atHost("Dikirim oleh server agentes.chat", "di", host) : "Dikirim oleh agentes.chat."),
  fallback: "Tombolnya tidak berfungsi? Salin alamat ini ke browser kamu:",
  role: { owner: "pemilik", member: "anggota" },
  anAgent: "Seorang agen",
  someone: "Seseorang",
  verify: {
    subject: "Konfirmasi email kamu untuk agentes.chat",
    preheader: "Satu klik untuk mengonfirmasi alamat ini. Tautannya berlaku satu jam.",
    headline: "Konfirmasi email kamu",
    body: "Tinggal satu langkah: konfirmasi bahwa alamat ini milikmu.",
    button: "Konfirmasi email",
    small: "Tautannya berlaku satu jam. Kalau kamu tidak mendaftar, abaikan saja email ini.",
    why: "Kamu menerima email ini karena alamat ini dipakai untuk mendaftar di agentes.chat.",
  },
  reset: {
    subject: "Atur ulang kata sandi agentes.chat kamu",
    preheader: "Pilih kata sandi baru. Tautannya berlaku satu jam.",
    headline: "Pilih kata sandi baru",
    body: "Kami menerima permintaan untuk mengatur ulang kata sandi alamat ini.",
    button: "Pilih kata sandi baru",
    note: "Tidak merasa meminta ini? Abaikan email ini. Kata sandimu tetap sama.",
    small: "Tautannya berlaku satu jam.",
    why: "Kamu menerima email ini karena seseorang meminta pengaturan ulang kata sandi alamat ini di agentes.chat.",
  },
  invitation: {
    subject: "Kamu diundang ke ruang kerja di agentes.chat",
    preheader: "Terima dalam 7 hari, dengan alamat email ini.",
    headline: "Kamu diundang ke ruang kerja",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} mengundangmu bergabung ke `, { b: org }, ` sebagai ${role}.`]
        : ["Kamu diundang bergabung ke ", { b: org }, ` sebagai ${role}.`],
    what: "agentes.chat adalah tempat orang dan agen AI bekerja bersama.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Pesannya: " }, `“${note}”`],
    button: "Terima undangan",
    small: "Undangan berlaku 7 hari. Terima dengan alamat email ini.",
    why: (org) =>
      `Kamu menerima email ini karena seseorang di ${org} mengundang alamat ini. Kalau kamu tidak mengenal mereka, abaikan saja. Tidak ada yang terjadi sampai kamu menerimanya.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} mengundangmu ke ruang kerja pribadinya di agentes.chat.`]
          : "Kamu diundang ke ruang kerja pribadi di agentes.chat.",
      why: () =>
        "Kamu menerima email ini karena seseorang mengundang alamat ini ke ruang kerja pribadinya. Kalau kamu tidak mengenalnya, abaikan saja. Tidak ada yang terjadi sampai kamu menerimanya.",
    },
  },
  inviteRequest: {
    subject: "Seseorang meminta undangan baru",
    preheader: "Undangannya sudah kedaluwarsa. Kamu bisa mengirim yang baru dari Anggota.",
    headline: "Seseorang meminta undangan baru",
    body: (email, org) =>
      email
        ? [{ b: email }, " membuka undangan kedaluwarsa ke ", { b: org }, " dan meminta yang baru."]
        : ["Seseorang dengan tautan undangan kedaluwarsa ke ", { b: org }, " meminta yang baru."],
    next: "Kalau kamu memang menunggunya, kirim undangan baru dari Anggota. Kalau tidak, tidak perlu melakukan apa-apa.",
    button: "Buka Anggota",
    why: (org) => `Kamu menerima email ini karena kamu membuat undangan ini, atau mengelola anggota ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " membuka undangan kedaluwarsa ke ruang kerjamu dan meminta yang baru."]
          : "Seseorang dengan tautan undangan kedaluwarsa ke ruang kerjamu meminta yang baru.",
      why: () =>
        "Kamu menerima email ini karena kamu membuat undangan ini, atau mengurus siapa saja yang ada di ruang kerjamu.",
    },
  },
  calendar: {
    subject: "Kamu diundang ke sebuah acara",
    preheader: (when) => `${when}. Lihat di kalender.`,
    headline: "Kamu diundang ke sebuah acara",
    facts: { event: "Acara", when: "Waktu", org: "Ruang kerja", by: "Diundang oleh" },
    someone: "Seseorang",
    button: "Lihat acaranya",
    why: (org) => `Kamu menerima email ini karena seseorang di ${org} mengundangmu ke sebuah acara.`,
    personal: {
      why: () => "Kamu menerima email ini karena seseorang di ruang kerjamu mengundangmu ke sebuah acara.",
    },
  },
  waitlist: {
    subject: "Konfirmasi tempatmu di daftar tunggu agentes.chat",
    preheader: "Satu klik dan tempatmu aman.",
    headline: "Konfirmasi tempatmu di daftar",
    body: (email) =>
      email
        ? ["Kami menerima permintaan untuk memasukkan ", { b: email }, " ke daftar tunggu agentes.chat."]
        : "Kami menerima permintaan untuk memasukkan alamat ini ke daftar tunggu agentes.chat.",
    approve: "Di sini, tidak ada hal penting yang terjadi tanpa persetujuan orang. Begitu juga dengan permintaan ini.",
    button: "Konfirmasi emailku",
    small:
      "Tautannya berlaku 48 jam. Bukan kamu? Abaikan email ini. Tanpa klik, alamat ini tidak akan masuk ke daftar.",
    why: "Kamu menerima email ini karena alamat ini didaftarkan ke daftar tunggu agentes.chat.",
  },
  earlyAccess: {
    subject: "Undanganmu ke agentes.chat sudah tiba",
    preheader: (days) => `Buat akunmu dalam ${days} hari, dengan alamat email ini.`,
    headline: "Aksesmu sudah siap",
    body: (email) => [{ b: email }, " sekarang bisa membuat akun dan ruang kerja di agentes.chat."],
    what: "agentes.chat adalah tempat orang dan agen AI bekerja bersama.",
    button: "Buat akunku",
    small: (days) =>
      `Tautannya berlaku ${days} hari, hanya untuk alamat ini. Daftar dengan kata sandi, atau dengan Google, GitHub, atau Apple di alamat yang sama.`,
    why: "Kamu menerima email ini karena alamat ini ada di daftar tunggu agentes.chat, atau diundang ke agentes.chat. Tidak ada yang terjadi sampai kamu mendaftar.",
  },
  earlyAccessAllowed: {
    subject: "Sekarang kamu bisa membuat ruang kerjamu sendiri",
    preheader: "Masuk dengan akun yang sudah kamu punya, lalu siapkan ruang kerjamu.",
    headline: "Buat ruang kerjamu sendiri",
    body: (email) => [
      "Sekarang kamu bisa membuat ruang kerjamu sendiri di agentes.chat dengan ",
      { b: email },
      ", akun yang sudah kamu punya.",
    ],
    button: "Buat ruang kerjaku",
    why: "Kamu menerima email ini karena akun ini mendapat akses awal ke agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Seorang agen sudah melewati 80% anggaran bulanannya",
      exhausted: "Seorang agen berhenti: anggaran bulanan habis",
    },
    preheader: {
      warning: "Di 100% agen ini berhenti sampai bulan berganti atau batasnya dinaikkan.",
      exhausted: "Agen ini tidak akan menjawab sampai bulan berganti atau batasnya dinaikkan.",
    },
    headline: { warning: "Seorang agen melewati 80% anggarannya", exhausted: "Seorang agen mencapai anggarannya" },
    used: (pct, org) => `Sudah memakai ${pct} anggaran bulan ini · ${org}`,
    warning: "Di 100% agen ini berhenti dan memberi tahu di kanal. Admin bisa mengubah batasnya di halaman agen.",
    exhausted: "Agen ini tidak akan menjawab sampai bulan berganti, atau sampai admin menaikkan batasnya.",
    button: "Lihat anggaran",
    why: (org) =>
      `Kamu menerima email ini karena kamu pemilik agen ini, atau admin di ${org}. Email ini dikirim di 80% dan di 100%, masing-masing sebulan sekali.`,
    personal: {
      warning: "Di 100% agen ini berhenti dan memberi tahumu. Kamu bisa mengubah batasnya di halaman agen.",
      exhausted:
        "Agen ini tidak akan menjawab sampai bulan berganti, atau sampai kamu menaikkan batasnya di halaman agen.",
      why: () =>
        "Kamu menerima email ini karena agen ini milikmu. Email ini dikirim di 80% dan di 100%, masing-masing sebulan sekali.",
    },
  },
  digest: {
    subject: (n) => (n === 1 ? "Ada permintaan yang menunggu persetujuanmu" : `${n} permintaan menunggu persetujuanmu`),
    preheader: "Permintaan kedaluwarsa setelah 24 jam, dan tidak ada yang berjalan tanpa keputusan.",
    headline: (n) => (n === 1 ? "Ada permintaan yang menunggumu" : `${n} permintaan menunggumu`),
    body: (n, org) => [
      "Di ",
      { b: org },
      n === 1
        ? ", seorang agen meminta izin melakukan sesuatu yang hanya bisa disetujui orang."
        : ", beberapa agen meminta izin melakukan hal yang hanya bisa disetujui orang.",
    ],
    age: (h) => `${h} jam lalu`,
    more: (k) => `Dan ${k} lagi.`,
    button: (n) => (n === 1 ? "Tinjau permintaannya" : "Buka persetujuan"),
    why: (org, hours) =>
      `Kamu menerima email ini karena kamu bisa menyetujui permintaan ini di ${org}.${hours ? ` Email ini dikirim saat permintaan menunggu lebih dari ${hours} jam, sekali per permintaan.` : ""}`,
    personal: {
      body: () => "Agenmu meminta izin melakukan sesuatu yang perlu persetujuanmu.",
      why: (_org, hours) =>
        `Kamu menerima email ini karena kamu bisa menyetujui permintaan ini.${hours ? ` Email ini dikirim saat permintaan menunggu lebih dari ${hours} jam, sekali per permintaan.` : ""}`,
    },
  },
  ready: {
    subject: "Komputer agen-agenmu sudah siap",
    preheader: {
      ai: "Berikutnya: hubungkan AI kamu, supaya agen-agenmu bisa berpikir.",
      task: "Berikutnya: beri agen-agenmu tugas pertama.",
      create: "Berikutnya: buat agen pertamamu.",
    },
    headline: "Komputer agen-agenmu sudah siap",
    computer: "Komputer agen-agenmu",
    body: (org) => [
      "Terima kasih sudah menunggu. Komputer ",
      { b: org },
      " sudah menyala dan siap, dengan pengguna tersendiri untuk tiap agen. Komputer ini menyala siang dan malam, jadi agen-agenmu bisa bekerja kapan saja.",
    ],
    facts: { cpus: "CPU", memory: "Memori", disk: "Disk" },
    next: "Langkah berikutnya",
    steps: {
      ai: [
        "Hubungkan AI kamu.",
        "Masuk dengan paket Claude atau ChatGPT kamu, paket coding AI lain, atau kunci API. Agen-agenmu berpikir dengannya.",
      ],
      task: ["Beri tugas pertama.", "Di #general, panggil agen dengan @ lalu sebutkan apa yang kamu butuhkan."],
      watch: [
        "Lihat mereka bekerja.",
        "Di halaman agen, tekan Buka untuk melihat komputernya secara langsung. Ambil alih kapan pun kamu mau, lalu kembalikan saat selesai.",
      ],
      create: ["Buat agen.", "Agen ini bekerja di komputer ini sejak awal."],
    },
    button: { ai: "Hubungkan AI kamu", task: "Beri tugas pertama", create: "Buat agen" },
    why: (org) =>
      `Kamu menerima email ini karena kamu pemilik ${org} di agentes.chat. Ini satu-satunya email tentang komputer ini.`,
    personal: {
      body: () =>
        "Terima kasih sudah menunggu. Komputer agen-agenmu sudah menyala dan siap, dengan pengguna tersendiri untuk tiap agen. Komputer ini menyala siang dan malam, jadi agen-agenmu bisa bekerja kapan saja.",
      steps: {
        task: ["Beri tugas pertama.", "Buka percakapan dengan salah satu agenmu dan sebutkan apa yang kamu butuhkan."],
      },
      why: () =>
        "Kamu menerima email ini karena ruang kerja ini di agentes.chat adalah milikmu. Ini satu-satunya email tentang komputer ini.",
    },
  },
  joinRequest: {
    subject: "Seseorang minta bergabung ke ruang kerjamu",
    preheader: "Setujui atau tolak di Anggota. Tidak ada yang terjadi sampai kamu menjawab.",
    headline: "Ada permintaan bergabung yang menunggu",
    body: (org) => ["Orang ini membuka tautan undangan ", { b: org }, " dan minta bergabung."],
    note: "Setujui hanya orang yang kamu kenal. Mereka bergabung sebagai anggota, kecuali kamu memilih peran lain di halaman itu.",
    approve: "Setujui",
    deny: "Tolak",
    more: ["Semua permintaan yang menunggu ", { nobr: "ada di Anggota." }],
    why: (org) =>
      `Kamu menerima email ini karena kamu pemilik atau admin di ${org}. Email ini dikirim paling sering sejam sekali.`,
    personal: {
      body: () => "Orang ini membuka tautan undangan ruang kerjamu dan minta bergabung.",
      why: () =>
        "Kamu menerima email ini karena kamu mengurus siapa yang bergabung ke ruang kerjamu. Email ini dikirim paling sering sejam sekali.",
    },
  },
  joinAnswer: {
    someone: "Seseorang",
    joined: {
      subject: "Permintaanmu untuk bergabung disetujui",
      preheader: "Kamu sudah masuk. Buka ruang kerjanya untuk mulai.",
      headline: "Kamu sudah masuk",
      body: (who, org, role) => [`${who} menyetujui permintaanmu. Kamu bergabung ke `, { b: org }, ` sebagai ${role}.`],
      button: "Buka ruang kerja",
    },
    invited: {
      subject: "Permintaanmu untuk bergabung disetujui",
      preheader: "Tinggal satu langkah: terima undangannya dalam 7 hari.",
      headline: "Disetujui: tinggal satu langkah",
      body: (who, org) => [`${who} menyetujui permintaanmu untuk bergabung ke `, { b: org }, "."],
      next: "Terima undangannya dengan alamat email ini dalam 7 hari.",
      button: "Terima undangan",
    },
    denied: {
      subject: "Permintaanmu untuk bergabung tidak disetujui",
      preheader: "Seseorang di ruang kerja itu sudah melihatnya dan tidak menyetujuinya.",
      headline: "Permintaanmu tidak disetujui",
      body: (org) => ["Seseorang di ", { b: org }, " sudah melihat permintaanmu dan tidak menyetujuinya."],
      reason: (reason) => [{ b: "Pesannya: " }, `“${reason}”`],
      small: "Kalau menurutmu ini keliru, minta seseorang di sana mengundangmu lewat email.",
    },
    why: (org) => `Kamu menerima email ini karena alamat ini minta bergabung ke ${org} di agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} menyetujui permintaanmu. Sekarang kamu sudah ada di ruang kerjanya.` },
      invited: { body: (who) => `${who} menyetujui permintaanmu untuk bergabung ke ruang kerjanya.` },
      denied: {
        preheader: "Orang itu sudah melihatnya dan tidak menyetujuinya.",
        body: () => "Orang yang kamu mintai sudah melihat permintaanmu dan tidak menyetujuinya.",
        small: "Kalau menurutmu ini keliru, minta dia mengundangmu lewat email.",
      },
      why: () => "Kamu menerima email ini karena alamat ini minta bergabung ke ruang kerja pribadi di agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} adalah kode agentes.chat kamu`,
    preheader: "Ketik di halaman itu untuk minta bergabung. Kodenya berlaku 10 menit.",
    headline: "Kodemu",
    body: (org) => ["Ketik kode ini di halaman itu untuk minta bergabung ke ", { b: org }, "."],
    small: ["Berlaku 10 menit. Kalau kamu tidak memintanya, ", { nobr: "abaikan email ini." }],
    why: (org) =>
      `Kamu menerima email ini karena seseorang mengetik alamat ini untuk minta bergabung ke ${org} di agentes.chat.`,
    personal: {
      body: () => "Ketik kode ini di halaman itu untuk minta bergabung ke ruang kerja ini.",
      why: () =>
        "Kamu menerima email ini karena seseorang mengetik alamat ini untuk minta bergabung ke ruang kerja pribadi di agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} adalah kodemu untuk menghapus ruang kerja`,
    subjectAccount: (code) => `${code} adalah kodemu untuk menghapus seluruh akunmu`,
    preheader: "Ketik di agentes.chat untuk mengonfirmasi. Kodenya berlaku 10 menit.",
    headline: "Kodemu",
    workspace: (org) => [
      "Ketik kode ini untuk menghapus ruang kerja ",
      { b: org },
      ". Ruang kerja ini langsung jadi hanya-baca untuk semua orang dan dihapus permanen 7 hari kemudian.",
    ],
    account: (email) => [
      "Ketik kode ini untuk menghapus seluruh akun ",
      { b: email },
      ", bukan hanya satu ruang kerja. Akun ini langsung keluar di semua perangkat dan dihapus permanen 7 hari kemudian, dan ruang kerja yang hanya berisi kamu ikut ditutup.",
    ],
    support: (address) => [
      "Berlaku 10 menit, dan tidak ada yang dihapus tanpa kode ini. Kalau ini bukan kamu, jangan bagikan kodenya dan kirim email ke ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Berlaku 10 menit, dan tidak ada yang dihapus tanpa kode ini. Kalau ini bukan kamu, jangan bagikan kodenya dan beri tahu pengelola server ini.",
    whyWorkspace: (org) => `Kamu menerima email ini karena akunmu meminta penghapusan ${org} di agentes.chat.`,
    whyAccount: "Kamu menerima email ini karena akunmu meminta untuk dihapus dari agentes.chat.",
    personal: {
      workspace: (org) => [
        "Ketik kode ini untuk menghapus ruang kerjamu ",
        { b: org },
        ". Ruang kerja ini langsung jadi hanya-baca dan dihapus permanen 7 hari kemudian.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Ruang kerja yang kamu ikuti akan dihapus pada ${day}`,
    preheader: "Sekarang hanya bisa dibaca. Pemilik masih bisa memulihkannya sampai saat itu.",
    headline: "Sebuah ruang kerja sedang dihapus",
    body: (by, org, day, time) => [
      { b: by },
      " menghapus ruang kerja ",
      { b: org },
      `. Sekarang hanya bisa dibaca dan akan hilang permanen pada ${day} pukul ${time}.`,
    ],
    owner: "Berubah pikiran? Pulihkan sebelum waktu itu.",
    button: "Pulihkan ruang kerja",
    member: "Kalau ini keliru, minta pemilik untuk memulihkannya.",
    why: (org) => `Kamu menerima email ini karena kamu ada di ${org} di agentes.chat.`,
    personal: {
      member: "Kalau ini keliru, minta orang yang menghapusnya untuk memulihkannya.",
      why: () => "Kamu menerima email ini karena kamu ada di ruang kerja ini di agentes.chat.",
    },
  },
  restored: {
    subject: "Ruang kerja yang kamu ikuti sudah kembali",
    preheader: "Pemilik memulihkannya. Ruang kerja ini bisa dipakai lagi.",
    headline: "Ruang kerjanya sudah kembali",
    body: (by, org) => [{ b: by }, " memulihkan ", { b: org }, ". Ruang kerja ini bisa dipakai lagi."],
    button: "Buka ruang kerja",
    why: (org) => `Kamu menerima email ini karena kamu ada di ${org} di agentes.chat.`,
    personal: {
      why: () => "Kamu menerima email ini karena kamu ada di ruang kerja ini di agentes.chat.",
    },
  },
  appConnected: {
    subject: "Sebuah aplikasi terhubung ke akun agentes.chat kamu",
    preheader: "Aplikasi ini bisa membaca dan mengirim tugas ke agen atas namamu di satu ruang kerja.",
    headline: "Sebuah aplikasi terhubung",
    body: (app, org) => [{ b: app }, " sekarang punya akses ke akunmu di ", { b: org }, "."],
    note: "Bukan kamu yang menghubungkannya? Putuskan sekarang dan ganti kata sandimu.",
    button: "Lihat aplikasi yang terhubung",
    why: (org) => `Kamu menerima email ini karena sebuah aplikasi terhubung ke akunmu di ${org} di agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " sekarang punya akses ke akunmu di ruang kerja pribadimu."],
      why: () =>
        "Kamu menerima email ini karena sebuah aplikasi terhubung ke akunmu di ruang kerja pribadimu di agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Akun agentes.chat kamu akan dihapus pada ${day}`,
    preheader: "Kamu punya 7 hari untuk berubah pikiran.",
    headline: "Akunmu sedang dihapus",
    body: (email, day, time) => [
      "Kami akan menghapus akun ",
      { b: email },
      ` pada ${day} pukul ${time}. Akun ini sudah keluar di semua perangkat, dan tidak ada yang bisa menghubungimu di sini sampai kamu kembali.`,
    ],
    closes: (_count, names) => [
      "Ruang kerja yang hanya berisi kamu sudah ditutup dan hilang pada tanggal yang sama: ",
      ...names,
      ".",
    ],
    undo: "Berubah pikiran? Masuk sebelum tanggal itu dan tekan Pulihkan.",
    button: "Masuk untuk memulihkan",
    why: "Kamu menerima email ini karena alamat ini punya akun di agentes.chat.",
  },
  accountDeleted: {
    subject: "Akun agentes.chat kamu sudah dihapus",
    preheader: "Akun ini sudah keluar di semua perangkat dan tidak bisa masuk lagi.",
    headline: "Akunmu sudah dihapus",
    body: (email) => ["Kami sudah menghapus akun ", { b: email }, "."],
    closes: (_count, day, names) => [
      `Ruang kerja yang hanya berisi kamu sudah ditutup dan akan dihapus permanen pada ${day}: `,
      ...names,
      ".",
    ],
    support: (address) => ["Kalau ini bukan kamu, kirim email ke ", { mail: address }, "."],
    noSupport: "Kalau ini bukan kamu, beri tahu pengelola server ini.",
    why: "Kamu menerima email ini karena alamat ini punya akun di agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agen pada ${day}: ${stalls} macet, ${noise} proses sia-sia`,
    preheader: "Di mana agen berhenti dan di mana mereka bertindak sia-sia, dibandingkan 7 hari sebelumnya.",
    headline: (day) => `Macet dan sia-sia pada ${day}`,
    body: "Semua ruang kerja aktif di server ini, selama satu hari UTC. Hanya nama dan angka.",
    stalls: "Macet",
    noise: "Sia-sia",
    metric: {
      mentionNoRun: "Sebutan yang tidak membangunkan siapa pun",
      readOnly: "Proses yang hanya bisa membaca",
      promiseUnkept: "Selesai dengan pekerjaan tertunda",
      promiseIgnored: "Masih tertunda setelah diingatkan",
      handoffUnanswered: "Serah terima tak dijawab dalam 30 menit",
      limitStops: "Dihentikan oleh batas",
      personUnanswered: "Orang tak dijawab dalam 10 menit",
      taskStartFailed: "Tugas yang gagal di awal",
      noiseRuns: "Proses sia-sia",
      quietRuns: "Selesai tanpa sepatah kata",
      ackReplies: "Membalas terima kasih atau oke",
      idleWakes: "Dibangunkan tanpa ada kerjaan",
      noiseTokens: "Token yang dipakai",
      noiseCostNanoUsd: "Biayanya",
    },
    value: (today, average) => `${today} · rata-rata 7 hari ${average}`,
    topStalls: "Paling banyak macet",
    topNoise: "Paling banyak proses sia-sia, dengan biayanya",
    none: "Tidak ada ruang kerja.",
    table: (day) => `Tabel lengkapnya: bun run report:autonomy --day ${day}`,
    why: "Kamu menerima email ini karena alamat ini ada di OPS_REPORT_EMAIL di server ini. Email ini dikirim sekali sehari.",
  },
  planOpened: {
    subject: (plan) => `Lebih banyak orang bisa bicara dengan agenmu lewat paket ${plan} kamu`,
    preheader: (plan) => `Percakapan mereka memakai paket ${plan} kamu dan batasnya.`,
    headline: "Lebih banyak orang bisa bicara dengan agenmu",
    body: (by, agent, plan) => [
      { b: by },
      " membuat lebih banyak orang bisa bicara dengan ",
      { b: agent },
      `. Percakapan mereka memakai paket ${plan} kamu dan batasnya.`,
    ],
    agent: "Agen",
    by: "Diubah oleh",
    was: "Sebelumnya",
    now: "Sekarang",
    everyone: "Semua orang di workspace",
    onlyYou: "Hanya kamu",
    you: "Kamu",
    note: "Untuk membatalkannya, ubah Siapa yang bisa bicara di halaman agen.",
    button: "Lihat siapa yang bisa bicara",
    why: (org) =>
      `Kamu menerima email ini karena agenmu di ${org} berpikir dengan paketmu dan orang lain mengubah siapa yang bisa bicara dengannya.`,
    personal: {
      why: () =>
        "Kamu menerima email ini karena agenmu berpikir dengan paketmu dan orang lain mengubah siapa yang bisa bicara dengannya.",
    },
  },
  planLent: {
    subject: (plan) => `Paket ${plan} kamu sekarang berpikir untuk agen lain`,
    preheader: (plan) => `Percakapannya memakai paket ${plan} kamu dan batasnya. Kamu bisa menariknya kembali.`,
    headline: "Seseorang menghubungkan paketmu ke sebuah agen",
    body: (by, agent, plan) => [
      { b: by },
      ` menghubungkan paket ${plan} kamu ke agen `,
      { b: agent },
      ". Percakapannya memakai paketmu dan batasnya.",
    ],
    agent: "Agen",
    by: "Dihubungkan oleh",
    plan: "Paket",
    note: "Tarik kembali dengan satu klik dari notifikasimu, dan agen itu berhenti berpikir dengan paketmu.",
    button: "Buka notifikasi",
    why: (org) => `Kamu menerima email ini karena seseorang di ${org} menghubungkan paketmu ke sebuah agen.`,
    personal: {
      why: () => "Kamu menerima email ini karena seseorang di ruang kerjamu menghubungkan paketmu ke sebuah agen.",
    },
  },
  planWaiting: {
    subject: "Timmu sedang menunggu",
    preheader: "Ruang kerjamu sudah siap. Perlu paket agentes.chat untuk mulai.",
    headline: "Timmu sedang menunggu",
    body: (agents, channels, routines) => {
      const a = `${agents} agen`;
      const c = `${channels} kanal`;
      const r = `${routines} rutinitas`;
      return routines > 0
        ? `${a}, ${c}, dan ${r} sudah siap. Perlu paket agentes.chat untuk mulai.`
        : `${a} dan ${c} sudah siap. Perlu paket agentes.chat untuk mulai.`;
    },
    button: "Lihat paket agentes.chat",
    why: (org) =>
      `Kamu menerima email ini karena kamu mengelola ${org} di agentes.chat. Kami hanya mengirim dua pemberitahuan seperti ini.`,
    personal: {
      subject: "Agen-agenmu sedang menunggu",
      headline: "Agen-agenmu sedang menunggu",
      body: (agents, _channels, routines) => {
        const a = `${agents} agen`;
        const r = `${routines} rutinitas`;
        return `Siap jalan: ${routines > 0 ? `${a} dan ${r}` : a}. Tinggal perlu paket agentes.chat.`;
      },
      why: () =>
        "Kamu menerima email ini karena ruang kerja ini di agentes.chat adalah milikmu. Kami hanya mengirim dua pemberitahuan seperti ini.",
    },
  },
};
