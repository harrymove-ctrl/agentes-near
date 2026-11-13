/** Where to go in a phone's own Settings, when no button can open it: each screen's name, the last one ringed. */
export function SettingsPath({ segments, label }: { segments: string[]; label: string }) {
  return (
    <ol className="ac-setpath" aria-label={label}>
      {segments.map((s) => (
        <li key={s}>
          <span className="ac-setpath__seg">{s}</span>
        </li>
      ))}
    </ol>
  );
}
