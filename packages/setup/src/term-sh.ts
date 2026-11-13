/**
 * The agentes.chat look in POSIX sh, for the two installers: install.sh carries this text between its
 * `# --- term.sh` lines, and the runner's installer (apps/server/runner/install-script.ts) inlines it. Tests keep
 * both copies equal, and its logo equal to term.ts's in every color depth.
 */
export const TERM_SH = `# The agentes.chat look for the POSIX installers, as packages/setup/src/term.ts draws it: plain where a
# terminal can't take it (no color with NO_COLOR or TERM=dumb, ASCII marks and no logo on the Linux console), and
# no line, logo or animation when the output isn't a terminal (cloud-init, CI, the setup reading it). Only
# function definitions, so a download cut short runs nothing.

# t_init FD: everything goes to FD (1, or 2 when stdout is for --json), drawn for what that terminal shows.
t_init() {
  T_FD=$1 T_FRAME=0 T_OPEN=0 T_DEPTH=0 T_UNI=1 T_COLS=80 T_FOLD=0 T_LOG=''
  # A link in prose, without the punctuation after it.
  T_URL='https?://[^ <>"]*[^ <>".,:;)]'
  E=$(printf '\\033')
  if [ "\${TERM:-}" = linux ]; then T_UNI=0; fi
  if [ -t "$T_FD" ] && [ "\${TERM:-dumb}" != dumb ]; then
    # A log keeps each line whole, for grep; a terminal gets them wrapped at its width.
    if command -v fold >/dev/null 2>&1; then T_FOLD=1; fi
    T_FRAME=1
    if [ -z "\${NO_COLOR+x}" ]; then
      case \${COLORTERM:-} in
        truecolor | 24bit) T_DEPTH=24 ;;
        *) case \${TERM:-} in *256color*) T_DEPTH=256 ;; *) T_DEPTH=16 ;; esac ;;
      esac
    fi
    T_COLS=$( (stty size </dev/tty | cut -d ' ' -f 2) 2>/dev/null) || :
  fi
  case $T_COLS in '' | *[!0-9]*) T_COLS=80 ;; esac
  if [ "$T_COLS" -gt 80 ]; then T_COLS=80; fi
  if [ "$T_COLS" -lt 20 ]; then T_COLS=20; fi
  t_style
}

# The marks and the SGR codes for what t_init found; the line (T_B) once t_intro opens the frame.
t_style() {
  if [ "$T_UNI" = 1 ]; then
    M_START=┌ M_BAR=│ M_END=└ M_DONE=◇ M_ASK=◆ M_INFO=● M_WARN=▲ M_FAIL=■ M_SPIN=◒
  else
    M_START=+ M_BAR='|' M_END=+ M_DONE=o M_ASK='?' M_INFO='*' M_WARN='!' M_FAIL=x M_SPIN=-
  fi
  C_BOLD='' C_DIM='' C_ACC='' C_OK='' C_WARN='' C_FAIL='' C_OFF='' C_BADGE=''
  if [ "$T_DEPTH" != 0 ]; then
    C_BOLD="\${E}[1m" C_DIM="\${E}[2m" C_OK="\${E}[32m" C_WARN="\${E}[33m" C_FAIL="\${E}[31m" C_OFF="\${E}[0m"
    case $T_DEPTH in
      24) C_ACC="\${E}[38;2;43;116;230m" C_BADGE="\${E}[48;2;0;99;209;97m" ;;
      256) C_ACC="\${E}[38;5;32m" C_BADGE="\${E}[48;5;26;38;5;231m" ;;
      *) C_ACC="\${E}[94m" C_BADGE="\${E}[44;97m" ;;
    esac
  fi
  T_B=' '
  if [ "$T_OPEN" = 1 ]; then T_B="$C_DIM$M_BAR$C_OFF"; fi
}

# t_say MARK STYLE TEXT…: the mark, then the text wrapped under the line, in STYLE, its URLs in the accent.
t_say() {
  t_m=$1 t_s=$2
  shift 2
  printf '%s\\n' "$*" | t_fold | while IFS= read -r t_l; do
    t_l=\${t_l% }
    if [ -n "$C_ACC" ] && t_k=$( (printf '%s\\n' "$t_l" | sed -E "s#$T_URL#$C_ACC&$C_OFF$t_s#g") 2>/dev/null); then
      t_l=$t_k
    fi
    if [ -z "$t_l" ]; then printf '%s\\n' "$t_m"; else printf '%s  %s%s%s\\n' "$t_m" "$t_s" "$t_l" "\${t_s:+$C_OFF}"; fi
    t_m=$T_B
  done >&"$T_FD"
}

# t_fold [LEFT]: lines onto the width left beside the line, or beside LEFT columns (as they are, on a computer
# without fold).
t_fold() {
  if [ "$T_FOLD" = 1 ]; then
    fold -s -w $((T_COLS - \${1:-3}))
  else
    while IFS= read -r t_l; do printf '%s\\n' "$t_l"; done
  fi
}

t_step() { t_say "$C_OK$M_DONE$C_OFF" '' "$*"; }   # ◇ done or checked
t_info() { t_say "$C_ACC$M_INFO$C_OFF" "$C_BOLD" "$*"; }   # ● to read or do
t_warn() { t_say "$C_WARN$M_WARN$C_OFF" '' "$*"; }   # ▲ not as hoped, but it goes on
t_line() { t_say "$T_B" '' "$*"; }   # prose under the line
t_note() { t_say "$T_B" "$C_DIM" "$*"; }   # quieter prose
# t_cmd COMMAND [LABEL]: a command or a link to copy, on a line of its own, never wrapped.
t_cmd() { printf '%s    %s%s%s%s\\n' "$T_B" "\${2:+$C_DIM$2$C_OFF  }" "$C_ACC" "$1" "$C_OFF" >&"$T_FD"; }
# t_shell COMMAND: a command this runs (--plan, a failure), whole.
t_shell() { printf '%s  %s$ %s%s\\n' "$T_B" "$C_DIM" "$*" "$C_OFF" >&"$T_FD"; }
t_gap() { if [ "$T_OPEN" = 1 ]; then printf '%s\\n' "$T_B"; else printf '\\n'; fi >&"$T_FD"; }

# t_fail ERROR [FIX]: ■ what failed, then how to fix it, and the end of the frame. On stderr.
t_fail() {
  t_fd=$T_FD T_FD=2
  t_say "$C_FAIL$M_FAIL$C_OFF" "$C_BOLD" "$1"
  if [ $# -gt 1 ]; then t_say "$T_B" '' "$2"; fi
  t_stop
  T_FD=$t_fd
}

# └ Stopped where the frame is drawn. A log ends on the failure itself, so whatever reads its last line for
# the reason (the setup, a provisioner) finds it there.
t_stop() { if [ "$T_OPEN" = 1 ]; then t_end Stopped; fi; }

# t_end [TEXT]: └ and TEXT once the frame is open, which closes it; a log gets TEXT alone.
t_end() {
  if [ "$T_OPEN" = 1 ]; then
    T_OPEN=0 T_B=' '
    t_say "$C_DIM$M_END$C_OFF" '' "\${1:-}"
  elif [ "$T_FRAME" = 0 ] && [ -n "\${1:-}" ]; then
    printf '%s\\n' "$1" >&"$T_FD"
  fi
}

# t_intro TITLE: the logo where it fits, then ┌ and the badge, and the line from here on. A log gets the title.
t_intro() {
  if [ "$T_FRAME" = 0 ]; then
    printf 'agentes.chat %s\\n' "$1" >&"$T_FD"
    return 0
  fi
  if [ "$T_UNI" = 1 ] && [ "$T_COLS" -ge 64 ]; then t_logo; fi
  t_b=agentes.chat
  if [ "$T_DEPTH" != 0 ]; then t_b="$C_BADGE agentes.chat $C_OFF"; fi
  T_OPEN=1
  t_style
  # The title beside the badge's columns, its wrap under the line.
  t_m="$C_DIM$M_START$C_OFF  $t_b"
  printf '%s\\n' "$1" | t_fold 18 | while IFS= read -r t_l; do
    printf '%s %s\\n' "$t_m" "\${t_l% }"
    t_m="$T_B "
  done >&"$T_FD"
  printf '%s\\n' "$T_B" >&"$T_FD"
}

# The logo. The mark: the agent of packages/ui/src/agent/engine.js on the 12×12 grid of the web's LogoMark,
# rows of pixels where 0-4 are its body's tones (deep to light), w its eyes and . nothing. Beside it,
# "agentes" in pixels after Funnel Display Light. Two rows of pixels make one line of ▀▄█.
t_logo() {
  printf '\\n' >&"$T_FD"
  t_row=0
  set -- ..43434343.. .3333333332. '                         ▄' \\
    333333333233 232323232223 ' ▄▄▄   ▄▄▄▄  ▄▄▄  ▄ ▄▄  ▄█▄▄  ▄▄▄   ▄▄▄▄' \\
    3232w23w3222 2222w22w2212 ' ▄▄▄█ █   █ █▄▄▄█ █▀  █  █   █▄▄▄█ ▀▄▄▄' \\
    2222w22w2122 121212121112 '█   █ █   █ █     █   █  █   █         █' \\
    212121212111 111111111101 ' ▀▀▀▀  ▀▀▀█  ▀▀▀▀ ▀   ▀   ▀▀  ▀▀▀▀ ▀▀▀▀' \\
    11111111101. 0101010100.. '       ▀▀▀'
  while [ $# -ge 3 ]; do
    t_top=$1 t_bot=$2 t_word=$3
    shift 3
    t_line=''
    while [ -n "$t_top" ]; do
      t_cell "\${t_top%"\${t_top#?}"}" "\${t_bot%"\${t_bot#?}"}"
      t_line=$t_line$t_c
      t_top=\${t_top#?} t_bot=\${t_bot#?}
    done
    t_row=$((t_row + 1))
    if [ "$t_row" = 5 ]; then t_word="$t_word $C_DIM.chat$C_OFF"; fi
    printf '  %s%s   %s\\n' "$t_line" "$C_OFF" "$t_word" >&"$T_FD"
  done
  printf '\\n' >&"$T_FD"
}

# t_cell TOP BOTTOM: two pixels as one character, in $t_c.
t_cell() {
  if [ "$T_DEPTH" = 0 ]; then
    # One color: the body, its eyes left out (the mono logo).
    case $1$2 in
      [0-4][0-4]) t_c='█' ;;
      [0-4]?) t_c='▀' ;;
      ?[0-4]) t_c='▄' ;;
      *) t_c=' ' ;;
    esac
    return 0
  fi
  case $1$2 in
    ..) t_c=' ' ;;
    ?.) t_tone 38 "$1" && t_c="\${E}[0;\${t_n}m▀" ;;
    .?) t_tone 38 "$2" && t_c="\${E}[0;\${t_n}m▄" ;;
    *)
      t_tone 38 "$1"
      t_f=$t_n
      t_tone 38 "$2"
      if [ "$t_n" = "$t_f" ]; then
        t_c="\${E}[0;\${t_f}m█"
      else
        t_tone 48 "$2"
        t_c="\${E}[0;$t_f;\${t_n}m▀"
      fi
      ;;
  esac
}

# t_tone LAYER PIXEL: the SGR parameter of a pixel's tone as foreground (38) or background (48), in $t_n.
t_tone() {
  case $T_DEPTH in
    24)
      case $2 in
        0) t_n='0;61;130' ;; 1) t_n='0;99;209' ;; 2) t_n='70;147;232' ;; 3) t_n='140;195;255' ;;
        4) t_n='198;225;255' ;; *) t_n='255;255;255' ;;
      esac
      t_n="$1;2;$t_n"
      ;;
    256)
      case $2 in 0) t_n=25 ;; 1) t_n=26 ;; 2) t_n=68 ;; 3) t_n=111 ;; 4) t_n=189 ;; *) t_n=231 ;; esac
      t_n="$1;5;$t_n"
      ;;
    *)
      # Blue for the deep tones, bright blue for the light ones, bright white for the eyes.
      case $1$2 in
        380 | 381) t_n=34 ;; 38w) t_n=97 ;; 38?) t_n=94 ;; 480 | 481) t_n=44 ;; 48w) t_n=107 ;; *) t_n=104 ;;
      esac
      ;;
  esac
}

# t_ask QUESTION: yes or no on the terminal (Enter is yes); it stays as ◇ QUESTION Yes or No.
t_ask() {
  t_fd=$T_FD T_FD=3
  {
    t_say "$C_ACC$M_ASK$C_OFF" "$C_BOLD" "$1"
    printf '%s  %s(Y/n)%s ' "$C_ACC$M_BAR$C_OFF" "$C_DIM" "$C_OFF" >&3
  } 3>/dev/tty
  T_FD=$t_fd
  read -r t_a </dev/tty || t_a=n
  case $t_a in '' | [Yy]*) t_a=Yes ;; *) t_a=No ;; esac
  if [ "$T_FRAME" = 1 ]; then
    t_n=$(printf '%s\\n' "$1" | t_fold | wc -l) || t_n=1
    printf '%s[%dA\\r%s[J' "$E" $((t_n + 1)) "$E" >/dev/tty
  fi
  t_say "$C_OK$M_DONE$C_OFF" '' "$1 $t_a"
  [ "$t_a" = Yes ]
}

# t_run LABEL COMMAND…: COMMAND under a spinner with the seconds beside LABEL, its output kept in $T_LOG (in
# $T_LOGS when set) for t_tail; its exit status. The spinner turns beside COMMAND, not COMMAND beside it: a
# command sent to the background ignores Ctrl-C, which this way reaches COMMAND as from the terminal, then stops
# this with "Canceled". Without a terminal: LABEL once, and COMMAND's output in the log as it comes.
t_run() {
  t_label=$1
  shift
  if [ "$T_FRAME" = 0 ]; then
    t_say "$M_SPIN" '' "$t_label"
    "$@" >&"$T_FD" 2>&1 </dev/null
    return
  fi
  T_LOG=$(mktemp "\${T_LOGS:-\${TMPDIR:-/tmp}}/agentes-log.XXXXXX" 2>/dev/null) || T_LOG=/dev/null
  t_spin "$$" "$t_label" &
  t_sp=$!
  trap 't_unspin; t_say "$C_FAIL$M_FAIL$C_OFF" "" Canceled; t_end; exit 130' INT TERM HUP
  t_rc=0
  "$@" >"$T_LOG" 2>&1 </dev/null || t_rc=$?
  trap - INT TERM HUP
  t_unspin
  if [ "$t_rc" = 0 ] && [ "$T_LOG" != /dev/null ]; then rm -f "$T_LOG"; fi
  return "$t_rc"
}

t_unspin() {
  kill "$t_sp" 2>/dev/null || :
  wait "$t_sp" 2>/dev/null || :
  printf '\\r%s[2K' "$E" >&"$T_FD"
}

# t_spin PID LABEL: the spinner, drawn every 0.2 s while PID (the installer) runs.
t_spin() {
  t_i=0 t_t0=$(date +%s)
  t_lab=$(printf '%s' "$2" | cut -c "1-$((T_COLS - 12))")
  while kill -0 "$1" 2>/dev/null; do
    case $T_UNI$((t_i % 4)) in
      10) t_f=◒ ;; 11) t_f=◐ ;; 12) t_f=◓ ;; 13) t_f=◑ ;; 00) t_f=- ;; 01) t_f=\\\\ ;; 02) t_f='|' ;; *) t_f=/ ;;
    esac
    t_s=$(($(date +%s) - t_t0)) t_time=''
    if [ "$t_s" -ge 60 ]; then
      t_time="  $C_DIM$((t_s / 60))m $((t_s % 60 / 10))$((t_s % 10))s$C_OFF"
    elif [ "$t_s" -ge 3 ]; then
      t_time="  $C_DIM\${t_s}s$C_OFF"
    fi
    printf '\\r%s[2K%s  %s%s' "$E" "$C_ACC$t_f$C_OFF" "$t_lab" "$t_time" >&"$T_FD"
    sleep 0.2 2>/dev/null || sleep 1
    t_i=$((t_i + 1))
  done
}

# t_tail FILE: the last lines of a failed command's output, quiet, under the line.
t_tail() {
  if [ -f "$1" ]; then tail -n 12 "$1" | tr -d '\\r' | while IFS= read -r t_l; do t_note "$t_l"; done; fi
}
`;
