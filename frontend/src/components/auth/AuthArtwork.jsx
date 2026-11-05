/**
 * The hero panel's artwork: faceted copper and azure shapes over a dusk gradient, drawn here so
 * the sign-in pages need no photo (and no image licence). Decorative only.
 */

const COPPER = ['#f57a2e', '#c75000', '#843604'];
const AZURE = ['#7dd3fc', '#38bdf8', '#0369a1'];

// Facets of the central sculpture: [points, gradient id, opacity].
const FACETS = [
  ['210,70 285,150 235,230', 'copper', 0.95],
  ['210,70 235,230 160,175', 'azure', 0.85],
  ['160,175 235,230 190,300', 'copper', 0.75],
  ['235,230 300,265 245,335', 'azure', 0.9],
  ['190,300 245,335 175,370', 'copper', 0.9],
  ['285,150 335,205 300,265', 'copper', 0.7],
  ['235,230 285,150 300,265', 'azure', 0.55],
  ['120,240 160,175 190,300', 'azure', 0.5],
];

export default function AuthArtwork() {
  return (
    <div
      className="relative overflow-hidden rounded-3xl shadow-2xl shadow-slate-900/20 ring-1 ring-slate-900/10"
      aria-hidden="true"
    >
      <svg viewBox="0 0 480 420" className="block h-auto w-full">
        <defs>
          <linearGradient id="auth-art-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1e293b" />
            <stop offset="0.6" stopColor="#334155" />
            <stop offset="1" stopColor="#0f172a" />
          </linearGradient>
          <linearGradient id="auth-art-copper" x1="0" y1="0" x2="1" y2="1">
            {COPPER.map((color, index) => (
              <stop key={color} offset={index / (COPPER.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
          <linearGradient id="auth-art-azure" x1="1" y1="0" x2="0" y2="1">
            {AZURE.map((color, index) => (
              <stop key={color} offset={index / (AZURE.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
          <radialGradient id="auth-art-glow" cx="0.5" cy="0.55" r="0.5">
            <stop offset="0" stopColor="#f57a2e" stopOpacity="0.35" />
            <stop offset="1" stopColor="#f57a2e" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="480" height="420" fill="url(#auth-art-sky)" />
        {/* Window grid of an atrium behind the sculpture. */}
        {Array.from({ length: 7 }, (_, column) => (
          <rect
            key={`column-${column}`}
            x={20 + column * 66}
            y="30"
            width="50"
            height="230"
            rx="4"
            fill="#475569"
            opacity={0.18 + (column % 3) * 0.06}
          />
        ))}
        <rect x="0" y="330" width="480" height="90" fill="#0f172a" opacity="0.55" />
        <circle cx="235" cy="235" r="190" fill="url(#auth-art-glow)" />
        {FACETS.map(([points, gradient, opacity]) => (
          <polygon
            key={points}
            points={points}
            fill={`url(#auth-art-${gradient})`}
            opacity={opacity}
            stroke="#fff4ec"
            strokeOpacity="0.25"
            strokeWidth="1"
          />
        ))}
        <rect x="205" y="370" width="70" height="12" rx="3" fill="#1e293b" />
      </svg>
    </div>
  );
}
