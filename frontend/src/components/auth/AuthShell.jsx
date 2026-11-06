/**
 * The frame of every signed-out screen (sign in, sign up, check your email, forgot and reset
 * password, the confirmation link, the invitation), as in the sign-in designs:
 *
 *   page       soft blue light with a fine dot grid, exactly one screen high (h-dvh): nothing on
 *              the page scrolls
 *   card       a rounded light card holding, side by side on large screens,
 *     left     the showcase: animated artwork, "Back to Home" (the company website, when set) and a
 *              glass caption with slides, dots and arrows
 *     right    the screen: logo (or the screen's own header), title, description, content, footer;
 *              `surface="panel"` sets it on a white inner panel (the forgot-password design)
 *   small      the showcase is hidden and the screen fills the card
 *
 * Sizes and spacing scale with the window height (clamp on vh), so every screen fits from a small
 * laptop up. Only a screen taller than a very short window scrolls, inside its own column.
 *
 * The company's name, logo and links come from the server (hooks/usePublicAuthSettings.js); only
 * UI labels are written here, and every message a screen shows comes from the API.
 */

import { useEffect, useState } from 'react';
import BrandMark from '../BrandMark.jsx';
import { ArrowLeftIcon, ArrowRightIcon } from '../Icons.jsx';
import { AUTH_SLIDE_INTERVAL_MS } from '../../constants/authScreens.js';
import AuthArtwork from './AuthArtwork.jsx';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70';
const glassButton = `inline-flex items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white backdrop-blur-md transition hover:bg-white/15 ${focusRing}`;

/** The company's logo when it has set one, else the product's. */
export function CompanyLogo({ branding }) {
  if (branding?.logoUrl) {
    return <img src={branding.logoUrl} alt={branding.name} className="h-10 w-auto max-w-[10rem] object-contain" />;
  }
  return <BrandMark size="md" />;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function SlideCaption({ slides }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const slideCount = slides.length;

  useEffect(() => {
    if (isPaused || slideCount < 2 || prefersReducedMotion()) return undefined;
    const timer = setInterval(() => setActiveIndex((index) => (index + 1) % slideCount), AUTH_SLIDE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isPaused, slideCount]);

  const show = (index) => setActiveIndex((index + slideCount) % slideCount);
  const slide = slides[activeIndex];

  return (
    <div
      className="absolute inset-x-[clamp(1rem,2.2vh,1.75rem)] bottom-[clamp(1rem,2.2vh,1.75rem)] rounded-[1.4rem] border border-white/10 bg-gradient-to-br from-white/[0.10] to-white/[0.03] p-[clamp(1.25rem,3vh,2rem)] shadow-2xl shadow-black/40 backdrop-blur-xl"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      <div key={activeIndex} className="auth-rise" aria-live={isPaused ? 'polite' : 'off'}>
        <h2 className="font-display text-[clamp(1.15rem,2.9vh,1.75rem)] leading-[1.3] tracking-[-0.01em] text-white">
          {slide.title}
        </h2>
        <p className="mt-[clamp(0.5rem,1.4vh,0.9rem)] text-[clamp(0.875rem,1.9vh,1.05rem)] leading-relaxed text-white/75">
          {slide.text}
        </p>
      </div>
      <div className="mt-[clamp(1rem,3.4vh,2.25rem)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {slides.map((candidate, index) => (
            <button
              key={candidate.title}
              type="button"
              onClick={() => show(index)}
              aria-label={`Show slide ${index + 1} of ${slideCount}`}
              aria-current={index === activeIndex}
              className={`h-1.5 rounded-full transition-all duration-500 ${focusRing} ${
                index === activeIndex ? 'w-7 bg-white' : 'w-1.5 bg-white/35 hover:bg-white/60'
              }`}
            />
          ))}
        </div>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => show(activeIndex - 1)}
            aria-label="Previous slide"
            className={`h-10 w-10 ${glassButton}`}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => show(activeIndex + 1)}
            aria-label="Next slide"
            className={`h-10 w-10 ${glassButton}`}
          >
            <ArrowRightIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Showcase({ branding, slides }) {
  return (
    <section
      aria-roledescription="carousel"
      aria-label="About the workspace"
      className="relative hidden shrink-0 overflow-hidden rounded-[1.6rem] bg-[#020617] shadow-xl shadow-slate-900/20 lg:block lg:w-[45%] xl:w-[46%]"
    >
      <AuthArtwork />
      {branding?.websiteUrl && (
        <a
          href={branding.websiteUrl}
          className={`absolute top-[clamp(1rem,2.6vh,1.75rem)] left-[clamp(1rem,2.6vh,1.75rem)] gap-2 px-4 py-2 text-sm font-medium ${glassButton}`}
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to Home
        </a>
      )}
      <SlideCaption slides={slides} />
    </section>
  );
}

/**
 * @param {{ branding: object|null, slides: ReadonlyArray<{ title: string, text: string }>,
 *   title: React.ReactNode, description?: React.ReactNode, icon?: React.ReactNode,
 *   header?: React.ReactNode, footer?: React.ReactNode, surface?: 'card'|'panel',
 *   children: React.ReactNode }} props
 *   header replaces the logo row at the top of the screen; icon sits above the title
 */
export default function AuthShell({
  branding,
  slides,
  title,
  description,
  icon,
  header,
  footer,
  surface = 'card',
  children,
}) {
  const panelClasses =
    surface === 'panel'
      ? 'rounded-[1.6rem] bg-white shadow-xl shadow-blue-900/[0.06] ring-1 ring-slate-900/[0.04]'
      : '';
  return (
    <div className="auth-backdrop flex h-dvh w-full overflow-hidden p-2 font-sans text-slate-900 sm:p-4 lg:p-[clamp(0.75rem,3vh,2.25rem)]">
      <div className="mx-auto flex h-full w-full max-w-[1480px] gap-[clamp(0.75rem,1.6vw,1.75rem)] rounded-[2rem] bg-[#f1f4fb]/95 p-[clamp(0.5rem,1.6vh,1.1rem)] shadow-[0_40px_90px_-40px_rgba(30,58,138,0.45)] ring-1 ring-white/80">
        <Showcase branding={branding} slides={slides} />
        <main className={`flex min-w-0 flex-1 flex-col overflow-y-auto ${panelClasses}`}>
          <div className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col px-5 py-[clamp(1rem,3vh,2.25rem)] sm:px-8">
            <header className="flex min-h-10 items-center justify-between gap-4">
              {header ?? <CompanyLogo branding={branding} />}
            </header>
            <div className="auth-rise my-auto py-[clamp(0.75rem,2.6vh,2rem)]">
              {icon && <div className="mb-[clamp(0.75rem,2.2vh,1.5rem)]">{icon}</div>}
              <h1 className="font-display text-[clamp(1.35rem,3.4vh,2.05rem)] leading-[1.25] tracking-[-0.015em] text-slate-900">
                {title}
              </h1>
              {description && (
                <div className="mt-[clamp(0.25rem,1vh,0.6rem)] text-[clamp(0.875rem,1.95vh,1.05rem)] leading-relaxed text-slate-500">
                  {description}
                </div>
              )}
              <div className="mt-[clamp(1rem,3.2vh,2rem)]">{children}</div>
            </div>
            {footer && <footer className="text-center text-sm text-slate-500">{footer}</footer>}
          </div>
        </main>
      </div>
    </div>
  );
}
