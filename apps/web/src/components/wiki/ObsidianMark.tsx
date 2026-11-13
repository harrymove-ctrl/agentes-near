import { useId } from "react";

/** Obsidian's crystal, drawn for "Importar do Obsidian" only, to name the source. */
export function ObsidianMark({ size = 18 }: { size?: number }) {
  const id = useId();
  return (
    <svg className="obsidian-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b9a2ff" />
          <stop offset="1" stopColor="#6a3fe0" />
        </linearGradient>
      </defs>
      <path d="M9.1 2.5 16 5.2l2.8 7-2.4 8.2-6.9 1.2-4.7-5.6 1.7-8.6z" fill={`url(#${id})`} />
      <path
        d="M9.1 2.5 11 11.6l-5.4 4.2M11 11.6l7.8.6M11 11.6l-1.5 10"
        stroke="rgba(255,255,255,.4)"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}
