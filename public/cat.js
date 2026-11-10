// Pip, the mascot: an original flat SVG cat (cream fur, a grey patch over one ear, an orange nose).
// Poses: "perch" (head and front paws, sits on the top edge of the message box) and "head" (favicon, logo).
// State is a class on the <svg>: "idle" (slow blink), "searching" (looks side to side, ear twitches),
// "happy" (squints when an answer lands). All motion stops under prefers-reduced-motion.

export function catSVG({ pose = "head", state = "idle", label = "Pip" } = {}) {
  const viewBox = pose === "perch" ? "14 6 92 84" : "18 8 84 74";
  const paws =
    pose === "perch"
      ? `<ellipse cx="44" cy="82" rx="10" ry="6" fill="var(--fur)" stroke="var(--ink)" stroke-width="2.5"/>
         <path d="M40 80 L40 84 M45 80 L45 84" stroke="var(--ink)" stroke-width="1.4" stroke-linecap="round" opacity=".5"/>
         <ellipse cx="76" cy="82" rx="10" ry="6" fill="var(--fur)" stroke="var(--ink)" stroke-width="2.5"/>
         <path d="M75 80 L75 84 M80 80 L80 84" stroke="var(--ink)" stroke-width="1.4" stroke-linecap="round" opacity=".5"/>`
      : "";
  return `<svg class="cat ${state}" viewBox="${viewBox}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
  <g class="head">
    <path class="ear ear-l" d="M30 40 L28 12 L52 28 Z" fill="var(--patch)" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M33 34 L32 19 L45 28 Z" fill="var(--ear)"/>
    <path class="ear ear-r" d="M90 40 L92 12 L68 28 Z" fill="var(--fur)" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M87 34 L88 19 L75 28 Z" fill="var(--ear)"/>
    <ellipse cx="60" cy="48" rx="34" ry="28" fill="var(--fur)" stroke="var(--ink)" stroke-width="2.5"/>
    <path d="M28 40 C32 26 46 21 56 22 C50 28 46 38 34 46 C31 45 29 43 28 40 Z" fill="var(--patch)"/>
    <g class="eyes-open">
      <ellipse class="pupil" cx="47" cy="50" rx="3.6" ry="4.4" fill="var(--ink)"/>
      <ellipse class="pupil" cx="73" cy="50" rx="3.6" ry="4.4" fill="var(--ink)"/>
    </g>
    <g class="eyes-happy" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round">
      <path d="M42 51 Q47 45 52 51"/>
      <path d="M68 51 Q73 45 78 51"/>
    </g>
    <path d="M57 57 L63 57 L60 60.5 Z" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M54 63 Q57 66 60 63 Q63 66 66 63" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>
    <g stroke="var(--ink)" stroke-width="1.6" stroke-linecap="round" opacity=".55">
      <path d="M36 58 L22 56"/><path d="M36 62 L23 64"/>
      <path d="M84 58 L98 56"/><path d="M84 62 L97 64"/>
    </g>
  </g>
  ${paws}
</svg>`;
}

/** The head as a data URI, for the favicon. */
export function catFavicon() {
  const svg = catSVG()
    .replace(/var\(--fur\)/g, "#F7EDE2")
    .replace(/var\(--patch\)/g, "#A39B92")
    .replace(/var\(--ear\)/g, "#FFC9B3")
    .replace(/var\(--accent\)/g, "#FF8133")
    .replace(/var\(--ink\)/g, "#000");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
