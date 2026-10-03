/**
 * Layout shared by the login and signup pages.
 *
 *   lg and up:  [ brand panel (gradient, product highlights) | form column ]
 *   below lg:   brand mark on top, then the form card
 *
 * The brand panel is decorative and hidden from assistive technology except for its text.
 */

import BrandMark from './BrandMark.jsx';
import { APP_TAGLINE } from '../constants/app.js';

const PRODUCT_HIGHLIGHTS = [
  { title: 'Instant AI answers', description: 'Billing and technical specialists reply in seconds, day and night.' },
  { title: 'Seamless human handoff', description: 'Ask for a person any time and a support agent takes over the same chat.' },
  { title: 'Secure by design', description: 'Encrypted sessions, protected accounts, and your data never shared.' },
];

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-indigo-200" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
    </svg>
  );
}

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-slate-950 lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12 xl:p-16">
      {/* Layered gradients for depth. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-600 via-violet-700 to-slate-950 opacity-90" aria-hidden="true" />
      <div className="pointer-events-none absolute -top-32 -right-24 h-96 w-96 rounded-full bg-fuchsia-400/30 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-40 -left-20 h-[28rem] w-[28rem] rounded-full bg-indigo-400/25 blur-3xl" aria-hidden="true" />

      <div className="relative">
        <BrandMark tone="light" size="lg" />
      </div>

      <div className="relative max-w-md">
        <h2 className="text-4xl leading-tight font-bold tracking-tight text-white">Support that answers before you finish your coffee.</h2>
        <p className="mt-4 text-lg text-indigo-100/90">{APP_TAGLINE}</p>
        <ul className="mt-10 space-y-5">
          {PRODUCT_HIGHLIGHTS.map((productHighlight) => (
            <li key={productHighlight.title} className="flex gap-3">
              <CheckIcon />
              <div>
                <p className="font-semibold text-white">{productHighlight.title}</p>
                <p className="text-sm text-indigo-100/80">{productHighlight.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-sm text-indigo-100/70">© {new Date().getFullYear()} · Built for teams who care about every customer.</p>
    </aside>
  );
}

export default function AuthLayout({ heading, subheading, children, footer }) {
  return (
    <div className="flex min-h-screen bg-white">
      <BrandPanel />
      <main className="flex flex-1 flex-col justify-center px-4 py-10 sm:px-8 lg:px-16">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <BrandMark />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{heading}</h1>
          <p className="mt-2 text-sm text-slate-500">{subheading}</p>
          <div className="mt-8">{children}</div>
          <p className="mt-8 text-sm text-slate-600">{footer}</p>
        </div>
      </main>
    </div>
  );
}
