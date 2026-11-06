/**
 * The showcase panel's artwork: bundles of blue and gold light ribbons folding across deep navy,
 * drawn here as SVG, so the sign-in pages need no photo (and no image licence) and stay sharp at
 * any size. It fills its box (the parent sets the size) and is decorative only.
 *
 * Each bundle is many thin strands following one swirl, fanned apart where they fold, over a wide
 * soft glow of the same swirl. Motion (index.css): the bundles drift slowly, light runs along some
 * strands and a few sparks twinkle; all of it stops for people who ask for reduced motion.
 */

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 800;

/**
 * One swirl: a start point, then two cubic segments (control, control, end) ×2. `fan` is how far
 * apart the strands spread at each of the 7 points (start, c1, c2, mid, c3, c4, end), as [dx, dy].
 */
const BUNDLES = [
  {
    // From the top right, folding down through the middle and out to the left.
    points: [
      [700, -40],
      [520, 120],
      [620, 330],
      [360, 380],
      [120, 430],
      [180, 600],
      [-80, 560],
    ],
    fan: [
      [0, 6],
      [-6, 9],
      [4, 12],
      [3, 10],
      [-4, 13],
      [4, 9],
      [0, 7],
    ],
    strands: 22,
    colours: ['blue', 'pale', 'blue', 'gold'],
    glow: 'blue',
    duration: '19s',
  },
  {
    // A lower fold, from the right edge to the bottom left.
    points: [
      [680, 470],
      [480, 420],
      [430, 640],
      [250, 650],
      [80, 660],
      [60, 800],
      [-80, 860],
    ],
    fan: [
      [0, 6],
      [-3, 8],
      [5, 9],
      [2, 8],
      [-3, 9],
      [4, 7],
      [0, 6],
    ],
    strands: 18,
    colours: ['gold', 'blue', 'pale', 'blue'],
    glow: 'gold',
    duration: '23s',
  },
  {
    // A long arc from the upper left, crossing the others towards the lower right.
    points: [
      [-80, 160],
      [80, 120],
      [140, 300],
      [300, 520],
      [440, 720],
      [560, 640],
      [690, 760],
    ],
    fan: [
      [0, 5],
      [3, 6],
      [-5, 7],
      [-6, 6],
      [-4, 7],
      [3, 6],
      [0, 5],
    ],
    strands: 14,
    colours: ['pale', 'blue', 'blue', 'gold'],
    glow: 'blue',
    duration: '27s',
  },
];

/** The SVG path of strand `index` of a bundle, offset along its fan (centred on the bundle). */
function strandPath({ points, fan, strands }, index) {
  const offset = index - (strands - 1) / 2;
  const [p0, c1, c2, mid, c3, c4, end] = points.map(([x, y], pointIndex) => [
    (x + fan[pointIndex][0] * offset).toFixed(1),
    (y + fan[pointIndex][1] * offset).toFixed(1),
  ]);
  return `M ${p0} C ${c1} ${c2} ${mid} C ${c3} ${c4} ${end}`;
}

/** The bundle's middle strand, for its glow. */
const centrePath = (bundle) => strandPath(bundle, (bundle.strands - 1) / 2);

// Sparks: [x, y, radius, twinkle delay]
const SPARKS = [
  [470, 90, 1.6, '0s'],
  [530, 250, 1.2, '1.2s'],
  [330, 300, 1.4, '2.1s'],
  [240, 560, 1.1, '0.6s'],
  [520, 470, 1.3, '2.8s'],
  [140, 250, 1, '3.4s'],
  [90, 700, 1.2, '1.7s'],
  [410, 610, 1, '2.4s'],
  [300, 120, 1.1, '0.9s'],
];

const STRAND_STROKES = Object.freeze({
  blue: 'url(#auth-art-blue)',
  pale: 'url(#auth-art-pale)',
  gold: 'url(#auth-art-gold)',
});

export default function AuthArtwork() {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="auth-art-night" cx="72%" cy="30%" r="90%">
          <stop offset="0" stopColor="#0c2161" />
          <stop offset="0.5" stopColor="#06103a" />
          <stop offset="1" stopColor="#01041a" />
        </radialGradient>
        <linearGradient id="auth-art-blue" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d4ed8" stopOpacity="0.15" />
          <stop offset="0.35" stopColor="#3b82f6" />
          <stop offset="0.6" stopColor="#93c5fd" />
          <stop offset="1" stopColor="#1e40af" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="auth-art-pale" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#bfdbfe" stopOpacity="0.2" />
          <stop offset="0.45" stopColor="#dbeafe" />
          <stop offset="1" stopColor="#60a5fa" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="auth-art-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#92400e" stopOpacity="0.1" />
          <stop offset="0.4" stopColor="#d97706" />
          <stop offset="0.65" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#78350f" stopOpacity="0.2" />
        </linearGradient>
        <filter id="auth-art-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
        <filter id="auth-art-soft" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation="0.6" />
        </filter>
        <linearGradient id="auth-art-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#01041a" stopOpacity="0" />
          <stop offset="1" stopColor="#01041a" stopOpacity="0.65" />
        </linearGradient>
      </defs>

      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#auth-art-night)" />

      {BUNDLES.map((bundle) => (
        <g key={bundle.duration} className="auth-drift" style={{ animationDuration: bundle.duration }}>
          <path
            d={centrePath(bundle)}
            fill="none"
            stroke={bundle.glow === 'gold' ? '#b45309' : '#2563eb'}
            strokeWidth={bundle.strands * 6}
            strokeLinecap="round"
            opacity="0.32"
            filter="url(#auth-art-glow)"
          />
          <g filter="url(#auth-art-soft)">
            {Array.from({ length: bundle.strands }, (_, index) => (
              <path
                key={index}
                d={strandPath(bundle, index)}
                fill="none"
                stroke={STRAND_STROKES[bundle.colours[index % bundle.colours.length]]}
                strokeWidth={index % 5 === 0 ? 2.4 : 1.2}
                strokeLinecap="round"
                opacity={0.45 + ((index * 7) % 5) * 0.11}
              />
            ))}
          </g>
          {Array.from({ length: bundle.strands }, (_, index) => index)
            .filter((index) => index % 4 === 1)
            .map((index) => (
              <path
                key={`shine-${index}`}
                d={strandPath(bundle, index)}
                fill="none"
                stroke={bundle.colours[index % bundle.colours.length] === 'gold' ? '#fde68a' : '#e0f2fe'}
                strokeWidth="2"
                strokeLinecap="round"
                className="auth-shimmer"
                style={{ animationDelay: `${(index * 1.3) % 9}s` }}
                opacity="0.9"
              />
            ))}
        </g>
      ))}

      {SPARKS.map(([x, y, radius, delay]) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={radius}
          fill="#e0f2fe"
          className="auth-twinkle"
          style={{ animationDelay: delay }}
        />
      ))}

      {/* The lower part darkens, so the caption card reads clearly over it. */}
      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#auth-art-fade)" />
    </svg>
  );
}
