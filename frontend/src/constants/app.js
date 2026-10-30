/** Product identity, in one place so a rebrand is a one-line change. */
export const APP_NAME = 'NSK';
export const APP_FULL_NAME = 'NSK Software Technologies';
export const APP_TAGLINE = 'Leave, attendance, payroll and people in one place, with AI agents built in.';

/** The logo files in public/brand/: white letters for dark backgrounds, charcoal for light ones. */
const LOGO_SIZE = Object.freeze({ width: 600, height: 197 });
export const BRAND_LOGO_FILES = Object.freeze({
  light: Object.freeze({ src: '/brand/nsk-logo-light.png', ...LOGO_SIZE }),
  dark: Object.freeze({ src: '/brand/nsk-logo.png', ...LOGO_SIZE }),
});
