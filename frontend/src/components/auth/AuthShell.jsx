/**
 * The frame of every signed-out screen (sign in, sign up, check your email, forgot and reset
 * password, invitation):
 *
 *   top bar      logo and company name; Sign in / Register; Support (when the company set an address)
 *   lg and up    [ hero panel: headline and artwork | the screen's own content ]
 *   below lg     the content only, under the top bar
 *   footer       © year and company name; terms and privacy links when the company set them
 *
 * The company's name, logo, support address and links come from the server
 * (hooks/usePublicAuthSettings.js); until they arrive the product's own name and logo are shown.
 * Only UI labels are written here; every message a screen shows comes from the API.
 */

import { Link } from 'react-router';
import BrandMark from '../BrandMark.jsx';
import { QuestionIcon } from '../Icons.jsx';
import { APP_FULL_NAME } from '../../constants/app.js';
import { DEFAULT_AUTH_HERO } from '../../constants/authScreens.js';
import { ROUTE_PATHS } from '../../constants/routes.js';
import AuthArtwork from './AuthArtwork.jsx';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

function CompanyLogo({ branding }) {
  if (branding?.logoUrl) {
    return <img src={branding.logoUrl} alt="" className="h-9 w-auto max-w-[9rem] object-contain" />;
  }
  return <BrandMark size="md" />;
}

function TopBar({ branding, activeLink }) {
  const navLink = (to, label, isPrimary) =>
    isPrimary ? (
      <Link
        to={to}
        className={`rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-500 ${focusRing}`}
      >
        {label}
      </Link>
    ) : (
      <Link
        to={to}
        className={`rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 ${focusRing}`}
      >
        {label}
      </Link>
    );

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to={ROUTE_PATHS.LOGIN} className={`flex min-w-0 items-center gap-3 rounded-lg ${focusRing}`}>
          <CompanyLogo branding={branding} />
          <span className="hidden truncate text-lg font-semibold tracking-tight text-slate-900 sm:block">
            {branding?.name ?? APP_FULL_NAME}
          </span>
        </Link>
        <nav aria-label="Account" className="flex shrink-0 items-center gap-1 sm:gap-2">
          {navLink(ROUTE_PATHS.LOGIN, 'Sign in', activeLink === 'login')}
          {navLink(ROUTE_PATHS.SIGNUP, 'Register', activeLink === 'signup')}
          {branding?.supportEmail && (
            <a
              href={`mailto:${branding.supportEmail}`}
              className={`ml-1 hidden items-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 sm:flex ${focusRing}`}
            >
              <QuestionIcon className="h-5 w-5" />
              Support
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}

function HeroPanel({ hero }) {
  return (
    <section
      aria-label="About the workspace"
      className="relative hidden flex-col justify-between gap-10 overflow-hidden border-r border-slate-200 bg-slate-50 px-10 py-12 lg:flex lg:w-1/2 xl:px-16"
    >
      <div className="max-w-xl">
        <p className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold tracking-wide text-brand-700 uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
          {hero.kicker}
        </p>
        <h2 className="mt-6 text-4xl leading-tight font-bold tracking-tight text-slate-900 xl:text-5xl">
          {hero.title} <span className="text-brand-600">{hero.accent}</span>
        </h2>
        <p className="mt-5 text-lg leading-relaxed text-slate-600">{hero.description}</p>
      </div>
      <AuthArtwork />
    </section>
  );
}

function Footer({ branding }) {
  const companyName = branding?.name ?? APP_FULL_NAME;
  const footerLink = (href, label) => (
    <a href={href} className={`rounded hover:text-slate-700 ${focusRing}`}>
      {label}
    </a>
  );
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          © {new Date().getFullYear()} {companyName}. All rights reserved.
        </p>
        <div className="flex gap-4">
          {branding?.termsUrl && footerLink(branding.termsUrl, 'Terms of service')}
          {branding?.privacyUrl && footerLink(branding.privacyUrl, 'Privacy policy')}
        </div>
      </div>
    </footer>
  );
}

/**
 * @param {{ branding: object|null, title: string, description?: React.ReactNode, hero?: object,
 *   activeLink?: 'login'|'signup', children: React.ReactNode, footer?: React.ReactNode }} props
 */
export default function AuthShell({
  branding,
  title,
  description,
  hero = DEFAULT_AUTH_HERO,
  activeLink,
  children,
  footer,
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <TopBar branding={branding} activeLink={activeLink} />
      <div className="flex flex-1">
        <HeroPanel hero={hero} />
        <main className="flex flex-1 flex-col justify-center px-4 py-10 sm:px-8 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-lg">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
            {description && <div className="mt-2 text-sm leading-relaxed text-slate-500">{description}</div>}
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-8 text-center text-sm text-slate-600">{footer}</div>}
          </div>
        </main>
      </div>
      <Footer branding={branding} />
    </div>
  );
}
