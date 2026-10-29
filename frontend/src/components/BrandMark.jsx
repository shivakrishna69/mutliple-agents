/**
 * The product logo: the Unitora mark, optionally with the "UNITORA HR" wordmark. `tone` picks the
 * logo's light colour (for the dark sidebar and panels) or its dark colour (for white pages). The
 * shapes come from constants/brandArtwork.js and are drawn in currentColor.
 */

import { APP_NAME } from '../constants/app.js';
import { BRAND_COLORS, LOGO_MARK, LOGO_WORDMARK } from '../constants/brandArtwork.js';

const MARK_SIZES = Object.freeze({ md: 'h-8 w-8', lg: 'h-10 w-10' });
const WORDMARK_HEIGHTS = Object.freeze({ md: 'h-3.5', lg: 'h-4' });

function LogoArtwork({ artwork, className }) {
  return (
    <svg
      viewBox={`0 0 ${artwork.width} ${artwork.height}`}
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={artwork.transform}>
        <path d={artwork.d} />
      </g>
    </svg>
  );
}

export default function BrandMark({ showName = true, tone = 'dark', size = 'md' }) {
  const color = tone === 'light' ? BRAND_COLORS.LIGHT : BRAND_COLORS.DARK;
  return (
    <span className="inline-flex items-center gap-3" style={{ color }} role="img" aria-label={APP_NAME}>
      <LogoArtwork artwork={LOGO_MARK} className={`${MARK_SIZES[size]} shrink-0`} />
      {showName && <LogoArtwork artwork={LOGO_WORDMARK} className={`${WORDMARK_HEIGHTS[size]} w-auto`} />}
    </span>
  );
}
