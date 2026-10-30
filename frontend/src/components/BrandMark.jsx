/**
 * The company logo. `tone` picks the version for the background behind it: "light" (white
 * letters) for the dark sidebar and panels, "dark" (charcoal letters) for white pages. The files
 * live in public/brand/ (constants/app.js names them).
 */

import { APP_FULL_NAME, BRAND_LOGO_FILES } from '../constants/app.js';

const LOGO_HEIGHTS = Object.freeze({ md: 'h-10', lg: 'h-14' });

export default function BrandMark({ tone = 'dark', size = 'md' }) {
  const logo = BRAND_LOGO_FILES[tone];
  return (
    <img
      src={logo.src}
      width={logo.width}
      height={logo.height}
      alt={APP_FULL_NAME}
      className={`${LOGO_HEIGHTS[size]} w-auto shrink-0`}
    />
  );
}
