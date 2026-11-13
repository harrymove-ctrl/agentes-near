/** Small bundled country marks; absent countries use the caller's globe. No remote assets. */
const stripes = (colors: string[], vertical = false) =>
  colors
    .map(
      (color, i) =>
        `<path fill="${color}" d="${vertical ? `M${(i * 30) / colors.length} 0h${30 / colors.length}v20H${(i * 30) / colors.length}z` : `M0 ${(i * 20) / colors.length}h30v${20 / colors.length}H0z`}"/>`,
    )
    .join("");
const star = `<path d="M0-1l.3.7.7.02-.55.45.2.75L0 .5l-.65.42.2-.75L-1-.28l.7-.02z"/>`;
const usa =
  stripes(Array.from({ length: 13 }, (_, i) => (i % 2 ? "#fff" : "#b31942"))) +
  `<path fill="#0a3161" d="M0 0h12v10.77H0z"/><g fill="#fff">` +
  Array.from({ length: 9 }, (_, row) =>
    Array.from(
      { length: row % 2 ? 5 : 6 },
      (_, col) => `<g transform="translate(${1 + col * 2 + (row % 2)} ${1 + row * 1.1}) scale(.5)">${star}</g>`,
    ).join(""),
  ).join("") +
  `</g>`;
const FLAGS: Record<string, string> = {
  US: usa,
  GB: `<path fill="#012169" d="M0 0h30v20H0z"/><path stroke="#fff" stroke-width="4" d="m0 0 30 20M30 0 0 20"/><path stroke="#c8102e" stroke-width="1.5" d="m0 0 30 20M30 0 0 20"/><path stroke="#fff" stroke-width="6" d="M15 0v20M0 10h30"/><path stroke="#c8102e" stroke-width="3.5" d="M15 0v20M0 10h30"/>`,
  CA: `<path fill="#fff" d="M0 0h30v20H0z"/><path fill="#d80621" d="M0 0h7v20H0zM23 0h7v20h-7zM15 3l1.3 3.2 1.7-.9-.5 4 2.6-2 0 1.8 2 .5-3.4 3 .6 1.4-3.8-.5.2 3.5h-1.4l.2-3.5-3.8.5.6-1.4-3.4-3 2-.5V7.3l2.6 2-.5-4 1.7.9z"/>`,
  ES: stripes(["#aa151b", "#f1bf00", "#f1bf00", "#aa151b"]),
  AT: stripes(["#ed2939", "#fff", "#ed2939"]),
  SE: `<path fill="#006aa7" d="M0 0h30v20H0z"/><path stroke="#fecc00" stroke-width="4" d="M11 0v20M0 10h30"/>`,
  CH: `<path fill="#da291c" d="M0 0h30v20H0z"/><path stroke="#fff" stroke-width="4" d="M15 4v12M9 10h12"/>`,
  DK: `<path fill="#c8102e" d="M0 0h30v20H0z"/><path stroke="#fff" stroke-width="3" d="M11 0v20M0 10h30"/>`,
  NO: `<path fill="#ba0c2f" d="M0 0h30v20H0z"/><path stroke="#fff" stroke-width="5" d="M11 0v20M0 10h30"/><path stroke="#00205b" stroke-width="3" d="M11 0v20M0 10h30"/>`,
  FI: `<path fill="#fff" d="M0 0h30v20H0z"/><path stroke="#002f6c" stroke-width="5" d="M11 0v20M0 10h30"/>`,
  RO: stripes(["#002b7f", "#fcd116", "#ce1126"], true),
  DE: stripes(["#000", "#d00", "#ffce00"]),
  FR: stripes(["#002654", "#fff", "#ed2939"], true),
  NL: stripes(["#ae1c28", "#fff", "#21468b"]),
  IT: stripes(["#009246", "#fff", "#ce2b37"], true),
  IE: stripes(["#169b62", "#fff", "#ff883e"], true),
  BE: stripes(["#000", "#fdda24", "#ef3340"], true),
  PL: stripes(["#fff", "#dc143c"]),
  UA: stripes(["#0057b7", "#ffd700"]),
  JP: `<path fill="#fff" d="M0 0h30v20H0z"/><circle fill="#bc002d" cx="15" cy="10" r="6"/>`,
  BR: `<path fill="#009739" d="M0 0h30v20H0z"/><path fill="#fedf00" d="m15 2 13 8-13 8L2 10z"/><circle fill="#002776" cx="15" cy="10" r="5"/><path fill="none" stroke="#fff" stroke-width=".8" d="M10.1 9a12 12 0 0 1 9.2 3"/><g fill="#fff"><circle cx="14" cy="13" r=".3"/><circle cx="16" cy="11.5" r=".3"/><circle cx="13" cy="10" r=".2"/><circle cx="17" cy="13" r=".2"/></g>`,
};
export function countryFlagSvg(country: string | undefined): string | null {
  const mark = country ? FLAGS[country.toUpperCase()] : undefined;
  return mark ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">${mark}</svg>` : null;
}
export const countryFlagUrl = (country: string | undefined) => {
  const svg = countryFlagSvg(country);
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null;
};
