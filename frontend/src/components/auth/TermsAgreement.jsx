/**
 * The words next to the "I agree" checkbox. The terms of service and privacy policy are links when
 * the company has set their addresses (company settings), and plain words otherwise; they open in a
 * new tab so the form keeps what was typed.
 */

import { APP_FULL_NAME } from '../../constants/app.js';

function DocumentLink({ href, children }) {
  if (!href) return <span className="font-medium text-slate-700">{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded font-medium text-brand-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </a>
  );
}

export default function TermsAgreement({ branding }) {
  return (
    <>
      I agree to {branding?.name ?? APP_FULL_NAME}&apos;s{' '}
      <DocumentLink href={branding?.termsUrl}>Terms of Service</DocumentLink> and{' '}
      <DocumentLink href={branding?.privacyUrl}>Privacy Policy</DocumentLink>.
    </>
  );
}
