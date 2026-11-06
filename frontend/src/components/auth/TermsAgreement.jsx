/**
 * The words beside the terms checkbox at signup and on the invitation, as in the sign-up design:
 * "I accepted all terms & condition". The terms link to the company's own page when its
 * administrator set one (company branding termsUrl); otherwise they are plain text.
 */

export default function TermsAgreement({ branding }) {
  const terms = 'terms & condition';
  return (
    <>
      I accepted all{' '}
      {branding?.termsUrl ? (
        <a
          href={branding.termsUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded font-medium text-brand-600 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
        >
          {terms}
        </a>
      ) : (
        terms
      )}
    </>
  );
}
